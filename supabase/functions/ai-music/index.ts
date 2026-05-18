import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

// AI 동행 — 음악 생성 Edge Function (Google Lyria 3 Clip)
// 입력:  { prompt: string }
// 출력:  { title: string, lyrics: string, audioUrl: string }
//        audioUrl 은 data: URL (data:audio/mp3;base64,...) — 클라이언트 <audio> 에 그대로 src로 꽂으면 재생됨.
// 비밀:  GEMINI_API_KEY (Supabase secret — Google AI Studio API 키)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// 시니어 어르신을 위한 따뜻한 시스템 가이드 — Lyria 프롬프트 앞에 덧붙임
function buildLyriaPrompt(userPrompt: string): string {
  return (
    `따뜻하고 잔잔한 한국 발라드. 어쿠스틱 기타와 부드러운 피아노. ` +
    `보컬은 60-80대 어르신이 듣기 편한 중간 템포(BPM 70-85). ` +
    `한 절(verse) + 한 후렴(chorus) 구조. 가사는 한국어로. ` +
    `주제: ${userPrompt.trim()}`
  )
}

// 응답 parts 중 첫 inlineData(=audio) 를 base64로 추출
function extractAudio(parts: any[]): { data: string; mimeType: string } | null {
  for (const p of parts || []) {
    const inline = p?.inlineData || p?.inline_data
    if (inline?.data) {
      return {
        data: String(inline.data),
        mimeType: String(inline.mimeType || inline.mime_type || 'audio/mpeg'),
      }
    }
  }
  return null
}

// 응답 parts 중 텍스트(가사) 를 모아 한 덩어리로
function extractText(parts: any[]): string {
  const buf: string[] = []
  for (const p of parts || []) {
    if (typeof p?.text === 'string' && p.text.trim().length > 0) buf.push(p.text.trim())
  }
  return buf.join('\n').trim()
}

// 텍스트 첫 줄을 제목, 나머지를 가사로 분리
function splitTitleAndLyrics(text: string, fallback: string): { title: string; lyrics: string } {
  const trimmed = (text || '').trim()
  if (!trimmed) return { title: fallback.slice(0, 18) || '오늘의 한 곡', lyrics: '' }
  const lines = trimmed.split(/\n+/)
  if (lines.length === 1) return { title: fallback.slice(0, 18) || '오늘의 한 곡', lyrics: trimmed }
  return { title: lines[0].trim().slice(0, 30), lyrics: lines.slice(1).join('\n').trim() }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { prompt } = await req.json()

    if (!prompt || String(prompt).trim().length === 0) {
      return new Response(
        JSON.stringify({ error: '어떤 노래를 만들어 드릴지 알려주세요' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY')
    if (!GEMINI_KEY) {
      return new Response(
        JSON.stringify({ error: '음악 도구 설정이 필요합니다 (GEMINI_API_KEY)' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Lyria 3 Clip — 30초 mp3. 첫 시연에 가장 가볍고 빠른 선택.
    const lyriaUrl = 'https://generativelanguage.googleapis.com/v1beta/models/lyria-3-clip-preview:generateContent'
    const lyriaBody = {
      contents: [{ parts: [{ text: buildLyriaPrompt(String(prompt)) }] }],
      generationConfig: {
        responseModalities: ['AUDIO', 'TEXT'],
      },
    }

    const lyriaRes = await fetch(lyriaUrl, {
      method: 'POST',
      headers: {
        'x-goog-api-key': GEMINI_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(lyriaBody),
    })

    if (!lyriaRes.ok) {
      const errText = await lyriaRes.text().catch(() => '')
      console.error('Lyria error:', lyriaRes.status, errText)
      return new Response(
        JSON.stringify({ error: '음악 도구에 일시적 문제가 있어요. 잠시 후 다시 시도해주세요.' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const data = await lyriaRes.json()
    const parts =
      data?.candidates?.[0]?.content?.parts ||
      data?.response?.candidates?.[0]?.content?.parts ||
      []

    const audio = extractAudio(parts)
    if (!audio) {
      console.error('Lyria response had no audio part:', JSON.stringify(data).slice(0, 800))
      return new Response(
        JSON.stringify({ error: '음원이 비어서 돌아왔어요. 다시 한 번 부탁드려 주세요.' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const rawText = extractText(parts)
    const { title, lyrics } = splitTitleAndLyrics(rawText, String(prompt))
    const audioUrl = `data:${audio.mimeType};base64,${audio.data}`

    return new Response(
      JSON.stringify({ title, lyrics, audioUrl }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('Function error:', err)
    return new Response(
      JSON.stringify({ error: '문제가 발생했어요. 잠시 후 다시 시도해주세요.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
