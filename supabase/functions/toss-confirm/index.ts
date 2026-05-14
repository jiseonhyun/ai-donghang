import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// 테스트 모드 기본 시크릿 키 (Toss 공식 문서 키). 운영 시 Supabase secret에 TOSS_SECRET_KEY 설정.
const DEFAULT_TEST_SECRET = 'test_sk_docs_OEP59LybZ8B6Jc5HK0qx6GYo7pRe'

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const { paymentKey, orderId, amount } = body || {}

    if (!paymentKey || !orderId || amount === undefined || amount === null) {
      return new Response(
        JSON.stringify({ error: 'paymentKey, orderId, amount는 필수입니다.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const TOSS_SECRET_KEY = Deno.env.get('TOSS_SECRET_KEY') || DEFAULT_TEST_SECRET
    const auth = btoa(TOSS_SECRET_KEY + ':')

    const tossResp = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
    })

    const data = await tossResp.json()

    if (!tossResp.ok) {
      console.error('Toss confirm failed:', data)
      return new Response(
        JSON.stringify({ error: data?.message || '결제 승인에 실패했어요.', code: data?.code, raw: data }),
        { status: tossResp.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({ ok: true, payment: data }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('toss-confirm error:', err)
    return new Response(
      JSON.stringify({ error: '결제 확인 중 오류가 발생했어요.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
