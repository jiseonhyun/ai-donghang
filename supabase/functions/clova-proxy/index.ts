// ─────────────────────────────────────────────────────────────────────────
// clova-proxy — Naver CLOVA Speech long-form 음성→텍스트 프록시
// ─────────────────────────────────────────────────────────────────────────
// 이유: webkitSpeechRecognition 은 안드로이드 Chrome 에서 MediaRecorder 와
// 마이크 공존 불가, Vosk small 은 정확도 부족(사용자 보고 ~90% 부정확).
// 한국어 시니어 발음 안정 인식이 핵심이라 Naver CLOVA Speech(한국어 특화
// 학습) 로 전환. 클라이언트가 녹음한 audio blob 을 이 함수에 보내면
// /recognizer/upload (sync) 호출 결과 fullText 만 추려 반환.
//
// 환경변수 (Supabase Dashboard → Functions → Secrets):
//   CLOVA_INVOKE_URL  CLOVA Speech 도메인의 Invoke URL 전체
//                     예: https://clovaspeech-gw.ncloud.com/external/v1/<DOMAIN_ID>/<INVOKE_KEY>
//   CLOVA_SECRET_KEY  같은 화면의 Secret Key
//
// 요청: multipart/form-data
//   - media: audio blob (webm/mp4/ogg 등 CLOVA 지원 포맷)
//
// 응답: { ok: boolean, text: string | null, segments?: any[], error?: string }
// ─────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'POST only' }, 405)
  }

  const INVOKE_URL = Deno.env.get('CLOVA_INVOKE_URL')
  const SECRET_KEY = Deno.env.get('CLOVA_SECRET_KEY')
  if (!INVOKE_URL || !SECRET_KEY) {
    return jsonResponse({ ok: false, error: 'CLOVA_INVOKE_URL / CLOVA_SECRET_KEY 환경변수 미설정' }, 500)
  }

  // 클라이언트가 보낸 multipart 에서 media 만 추출
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

  // CLOVA Speech long-form /recognizer/upload — sync 모드
  // params 의 fullText:true 로 전체 텍스트 한 번에 받음.
  const clovaForm = new FormData()
  clovaForm.append('media', mediaBlob, 'voice.webm')
  clovaForm.append(
    'params',
    JSON.stringify({
      language: 'ko-KR',
      completion: 'sync',
      callback: '',
      fullText: true,
    }),
  )
  clovaForm.append('type', 'application/json')

  let clovaRes: Response
  try {
    clovaRes = await fetch(INVOKE_URL.replace(/\/$/, '') + '/recognizer/upload', {
      method: 'POST',
      headers: { 'X-CLOVASPEECH-API-KEY': SECRET_KEY },
      body: clovaForm,
    })
  } catch (e) {
    return jsonResponse({ ok: false, error: 'CLOVA fetch 실패: ' + String(e) }, 502)
  }

  if (!clovaRes.ok) {
    const errText = await clovaRes.text().catch(() => '')
    return jsonResponse(
      { ok: false, status: clovaRes.status, error: errText.slice(0, 500) || 'CLOVA HTTP ' + clovaRes.status },
      502,
    )
  }

  let data: any = null
  try {
    data = await clovaRes.json()
  } catch (e) {
    return jsonResponse({ ok: false, error: 'CLOVA JSON 파싱 실패: ' + String(e) }, 502)
  }

  // 응답 포맷 (CLOVA long-form sync):
  // { text, segments[{start,end,text,...}], confidence, ... }
  // fullText 는 별도 필드 없이 text 또는 segments[*].text 조합.
  const fullText =
    (data && typeof data.text === 'string' && data.text) ||
    (Array.isArray(data?.segments)
      ? data.segments.map((s: any) => (s && s.text) || '').join(' ').trim()
      : null)

  return jsonResponse({
    ok: !!fullText,
    text: fullText || null,
    segments: Array.isArray(data?.segments) ? data.segments : undefined,
  })
})
