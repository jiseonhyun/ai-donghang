import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { prompt, systemPrompt, maxTokens } = await req.json()

    if (!prompt || prompt.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: '내용을 입력해주세요' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Claude API 호출 (Haiku 4.5 — 가장 빠르고 저렴)
    const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY')
    if (!ANTHROPIC_KEY) {
      return new Response(
        JSON.stringify({ error: 'API 설정이 필요합니다' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const sysMsg = systemPrompt || '당신은 60-80대 한국 어르신을 위한 따뜻하고 친절한 AI 도우미입니다. 어르신이 요청한 글을 정성스럽게 작성해주세요. 결과물만 바로 출력하세요. 설명이나 앞뒤 인사말은 넣지 마세요.'

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens || 1000,
        system: sysMsg,
        messages: [
          { role: 'user', content: prompt }
        ],
      }),
    })

    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text()
      console.error('Claude API error:', errText)
      return new Response(
        JSON.stringify({ error: 'AI 서비스에 일시적 문제가 있어요. 잠시 후 다시 시도해주세요.' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const data = await claudeResponse.json()
    const result = data.content?.[0]?.text || ''
    const tokensUsed = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)

    return new Response(
      JSON.stringify({ result, tokens: tokensUsed }),
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
