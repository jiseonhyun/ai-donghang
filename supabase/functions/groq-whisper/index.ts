// ─────────────────────────────────────────────────────────────────────────
// groq-whisper — Groq Whisper Large V3 한국어 음성→텍스트 프록시
// ─────────────────────────────────────────────────────────────────────────
// 이유: 안드로이드 Chrome 마이크 lock (webkitSR + MediaRecorder 공존 불가)
// 우회 + 무료 한국어 STT 필요. CLOVA 는 종량과금이라 운영 부담. Groq
// (whisper-large-v3) 은 무료 tier 가 자서전 사용에 충분 + Whisper Large
// 정확도 + 초고속 추론.
//
// 환경변수 (Supabase Dashboard → Functions → Secrets):
//   GROQ_API_KEY  console.groq.com 에서 발급 (가입만 하면 즉시 무료)
//
// 요청: multipart/form-data
//   - media: audio blob (webm/mp4/wav/mp3/ogg 등)
//
// 응답: { ok: boolean, text: string | null, error?: string }
//
// 한도 (Free tier, 2026-05 기준):
//   - 파일 25MB (자서전 25분 webm ≈ 5-10MB 라 안전)
//   - 분당 7200 토큰 / 일 28800 토큰 — 자서전 흐름 매우 넉넉
//   - 최소 10초 청구 (사용자가 1초 말해도 10초로 카운트)
// ─────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const GROQ_MODEL = 'whisper-large-v3'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'POST only' }, 405)
  }

  const GROQ_KEY = Deno.env.get('GROQ_API_KEY')
  if (!GROQ_KEY) {
    return jsonResponse({ ok: false, error: 'GROQ_API_KEY 환경변수 미설정' }, 500)
  }

  // 클라이언트 multipart 에서 media 추출 (필드명은 클라이언트의 'media' 사용 유지)
  let mediaBlob: Blob | null = null
  try {
    const form = await req.formData()
    const m = form.get('media')
    if (m instanceof Blob) mediaBlob = m
  } catch (e) {
    return jsonResponse({ ok: false, error: 'multipart 파싱 실패: ' + String(e) }, 400)
  }
  if (!mediaBlob || mediaBlob.size === 0) {
    return jsonResponse({ ok: false, error: 'media field 누락 또는 빈 파일' }, 400)
  }
  if (mediaBlob.size > 25 * 1024 * 1024) {
    return jsonResponse({ ok: false, error: '파일이 25MB 를 초과합니다 (Groq free tier 한도)' }, 413)
  }

  // Groq 는 OpenAI 호환이라 form field 이름이 'file' 임. multipart 재구성.
  const groqForm = new FormData()
  // Blob 자체에 filename 이 없으면 Groq 가 거부 — 명시적으로 'voice.webm' 부여.
  // type 으로 mime 가 같이 전달되므로 확장자가 type 과 어긋나도 보통 OK.
  groqForm.append('file', mediaBlob, 'voice.webm')
  groqForm.append('model', GROQ_MODEL)
  groqForm.append('language', 'ko')        // ISO 639-1 — 한국어 강제 (정확도/속도 ↑)
  groqForm.append('response_format', 'json')
  groqForm.append('temperature', '0')

  let groqRes: Response
  try {
    groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + GROQ_KEY },
      body: groqForm,
    })
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Groq fetch 실패: ' + String(e) }, 502)
  }

  if (!groqRes.ok) {
    const errText = await groqRes.text().catch(() => '')
    return jsonResponse(
      { ok: false, status: groqRes.status, error: errText.slice(0, 500) || 'Groq HTTP ' + groqRes.status },
      502,
    )
  }

  let data: any = null
  try {
    data = await groqRes.json()
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Groq JSON 파싱 실패: ' + String(e) }, 502)
  }

  // Whisper 응답: { text: "..." }
  const fullText = data && typeof data.text === 'string' ? data.text.trim() : null
  return jsonResponse({ ok: !!fullText, text: fullText || null })
})
