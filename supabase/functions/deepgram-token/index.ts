// ─────────────────────────────────────────────────────────────────────────
// deepgram-token — Deepgram WebSocket 연결용 임시 token 발급
// ─────────────────────────────────────────────────────────────────────────
// 이유: Deepgram WebSocket (wss://api.deepgram.com/v1/listen) 은 인증이 필요한데,
// 영구 API 키를 클라이언트에 노출하면 도용 위험. Deepgram 의 auth/grant 로
// 60초 짜리 단명 token 을 발급받아 클라이언트에 전달. 클라이언트는 그 token
// 으로 WebSocket 핸드셰이크 → 연결 후엔 token 만료돼도 세션 유지.
//
// 환경변수 (Supabase Dashboard → Functions → Secrets):
//   DEEPGRAM_API_KEY  console.deepgram.com 에서 발급 (가입 즉시 무료, $200 크레딧)
//
// 요청: GET 또는 POST (body 없음)
// 응답: { ok: true, access_token: "eyJ...", expires_in: 60 }
// ─────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

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

  const DEEPGRAM_KEY = Deno.env.get('DEEPGRAM_API_KEY')
  if (!DEEPGRAM_KEY) {
    return jsonResponse({ ok: false, error: 'DEEPGRAM_API_KEY 환경변수 미설정' }, 500)
  }

  let dgRes: Response
  try {
    dgRes = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: {
        'Authorization': 'Token ' + DEEPGRAM_KEY,
        'Content-Type': 'application/json',
      },
      // 60초 TTL — WebSocket 핸드셰이크 + 약간의 여유. 연결 후엔 만료돼도 OK.
      body: JSON.stringify({ ttl_seconds: 60 }),
    })
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Deepgram fetch 실패: ' + String(e) }, 502)
  }

  if (!dgRes.ok) {
    const errText = await dgRes.text().catch(() => '')
    return jsonResponse(
      { ok: false, status: dgRes.status, error: errText.slice(0, 500) || 'Deepgram HTTP ' + dgRes.status },
      502,
    )
  }

  let data: any = null
  try {
    data = await dgRes.json()
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Deepgram JSON 파싱 실패: ' + String(e) }, 502)
  }

  if (!data || !data.access_token) {
    return jsonResponse({ ok: false, error: 'access_token 누락' }, 502)
  }

  return jsonResponse({
    ok: true,
    access_token: data.access_token,
    expires_in: data.expires_in || 60,
  })
})
