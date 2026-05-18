import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

// AI 동행 — 이미지 생성 Edge Function (fal.ai FLUX schnell)
// 입력:  { prompt: string, imageSize?: string }
// 출력:  { url: string, prompt: string }
// 비밀:  FAL_KEY (Supabase secret — fal.ai API 키)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { prompt, imageSize } = await req.json()

    if (!prompt || String(prompt).trim().length === 0) {
      return new Response(
        JSON.stringify({ error: '어떤 그림을 그려드릴지 알려주세요' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const FAL_KEY = Deno.env.get('FAL_KEY')
    if (!FAL_KEY) {
      return new Response(
        JSON.stringify({ error: '그림 도구 설정이 필요합니다 (FAL_KEY)' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // fal.ai FLUX schnell — 빠르고 저렴 (~1초). 시니어 시연에 적합.
    const falResponse = await fetch('https://fal.run/fal-ai/flux/schnell', {
      method: 'POST',
      headers: {
        'Authorization': 'Key ' + FAL_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: String(prompt),
        image_size: imageSize || 'landscape_4_3',
        num_inference_steps: 4,
        num_images: 1,
        enable_safety_checker: true,
      }),
    })

    if (!falResponse.ok) {
      const errText = await falResponse.text().catch(() => '')
      console.error('fal.ai error:', falResponse.status, errText)
      return new Response(
        JSON.stringify({ error: '그림 도구에 일시적 문제가 있어요. 잠시 후 다시 시도해주세요.' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const data = await falResponse.json()
    const url = data?.images?.[0]?.url
    if (!url) {
      return new Response(
        JSON.stringify({ error: '그림이 비어서 돌아왔어요. 다시 한 번 부탁드려 주세요.' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({ url, prompt: String(prompt) }),
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
