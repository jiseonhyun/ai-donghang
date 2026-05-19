-- ============================================================================
-- Phase B 적용 후 회귀 검증 체크리스트
-- ============================================================================
-- 사용법: 각 섹션을 순서대로 Supabase SQL Editor에서 실행.
--         "기대" 조건과 다르면 즉시 중단하고 phase_b_rollback.sql 적용 여부 결정.
--
-- 클라이언트(브라우저) 테스트는 §C에 수동 항목으로 정리.
-- ============================================================================


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ §A. DB 측 자동 검증 (SQL Editor 실행)                                    │
-- └──────────────────────────────────────────────────────────────────────────┘

-- A-1. RLS 활성화 일괄 확인
-- 기대: 11개 테이블 모두 rowsecurity = true
SELECT relname AS table_name, relrowsecurity AS rls_enabled
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relkind = 'r'
ORDER BY relname;

-- A-2. 정책 일람
-- 기대: profiles 2개, works 4개, user_stories 1개, user_progress 3개,
--       autobiography_courses 1개, autobiography_sessions 1개,
--       autobiography_chapters 1개, community_works 4개,
--       question_pool 1개, trial_signups 1개. 합 19개.
SELECT schemaname, tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- A-3. profiles 4명 마이그레이션 확인
-- 기대: 4
SELECT COUNT(*) AS profile_count FROM public.profiles;

-- A-4. auth.users ↔ profiles 일치 확인
-- 기대: 0 (모든 profiles row가 auth.users에 대응)
SELECT COUNT(*) AS orphan_profiles
FROM public.profiles p
LEFT JOIN auth.users a ON a.id = p.id
WHERE a.id IS NULL;

-- A-5. 자식 테이블 user_id 무결성
-- 기대: 모든 행이 0 (고아 데이터 없음)
SELECT 'works'                 AS table, COUNT(*) AS orphan
FROM public.works w LEFT JOIN public.profiles p ON p.id = w.user_id
WHERE w.user_id IS NOT NULL AND p.id IS NULL
UNION ALL SELECT 'user_stories',
  COUNT(*) FROM public.user_stories us LEFT JOIN public.profiles p ON p.id = us.user_id
  WHERE us.user_id IS NOT NULL AND p.id IS NULL
UNION ALL SELECT 'user_progress',
  COUNT(*) FROM public.user_progress up LEFT JOIN public.profiles p ON p.id = up.user_id
  WHERE p.id IS NULL
UNION ALL SELECT 'autobiography_courses',
  COUNT(*) FROM public.autobiography_courses ac LEFT JOIN public.profiles p ON p.id = ac.user_id
  WHERE ac.user_id IS NOT NULL AND p.id IS NULL
UNION ALL SELECT 'community_works',
  COUNT(*) FROM public.community_works cw LEFT JOIN public.profiles p ON p.id = cw.user_id
  WHERE cw.user_id IS NOT NULL AND p.id IS NULL;

-- A-6. 기존 사용자 데이터 보존 확인 (현지선 user_id=1 → UUID)
-- 기대: 현지선 회원 1명, user_stories 7개, autobiography_courses 2개
SELECT
  p.name,
  (SELECT COUNT(*) FROM public.user_stories WHERE user_id = p.id) AS stories,
  (SELECT COUNT(*) FROM public.autobiography_courses WHERE user_id = p.id) AS courses,
  (SELECT COUNT(*) FROM public.works WHERE user_id = p.id) AS works
FROM public.profiles p
WHERE p.name = '현지선';

-- A-7. 정리 테이블 제거 확인
-- 기대: 두 쿼리 모두 0
SELECT COUNT(*) AS old_users_remain
FROM information_schema.tables
WHERE table_schema='public' AND table_name='Users';
SELECT COUNT(*) AS map_remain
FROM information_schema.tables
WHERE table_schema='public' AND table_name='_migration_user_id_map';

-- A-8. handle_new_user 트리거 존재 확인
-- 기대: 1
SELECT COUNT(*) AS trigger_exists
FROM information_schema.triggers
WHERE event_object_schema='auth'
  AND event_object_table='users'
  AND trigger_name='on_auth_user_created';


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ §B. anon 권한 차단 검증 (실행 시 권한 컨텍스트를 anon으로 바꿔서 실행)  │
-- └──────────────────────────────────────────────────────────────────────────┘
-- SQL Editor 우측 상단 role 선택: anon
-- 또는 별도 터미널에서 anon 키로 REST 호출:

-- B-1. anon은 profiles 못 봄
-- curl + anon key:
--   GET /rest/v1/profiles?select=*
-- 기대: 빈 배열 [] (정책 매치 없음)

-- B-2. anon은 works 못 봄
-- curl + anon key:
--   GET /rest/v1/works?select=*
-- 기대: 빈 배열 [] (이전엔 11행 전부 노출되던 곳)

-- B-3. anon은 user_stories 못 봄
-- curl + anon key:
--   GET /rest/v1/user_stories?select=*
-- 기대: 빈 배열 []

-- B-4. anon은 autobiography_chapters 못 봄
-- 기대: 빈 배열 []

-- B-5. anon은 community_works 공개 SELECT 가능
-- 기대: 행 반환 (공개 정책)

-- B-6. anon은 question_pool (is_active=true) 공개 SELECT 가능
-- 기대: 행 반환

-- B-7. anon은 trial_signups INSERT 가능
-- curl + anon key:
--   POST /rest/v1/trial_signups  {"name":"테스트","phone":"010-0000-0000"}
-- 기대: 201 Created

-- B-8. anon은 trial_signups SELECT 불가
-- 기대: 빈 배열 []


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ §C. 클라이언트 (브라우저) 수동 회귀 테스트                                │
-- └──────────────────────────────────────────────────────────────────────────┘
-- 각 항목 OK / FAIL 체크:
--
-- C-1. [ ] 비로그인 상태에서 ai-donghang.html 접속 — 홈/도장/빌더/커뮤니티 정상 표시
-- C-2. [ ] 카카오 로그인 버튼 클릭 → Supabase Auth → kakao OAuth 흐름 진입
--          (사전: 대시보드 Providers → Kakao 활성화 + Client ID/Secret 등록)
-- C-3. [ ] 카카오 로그인 성공 후 마이페이지 진입 — 이름/플랜 정상 표시
-- C-4. [ ] 작품 생성 후 "작품함에 저장" → works 테이블에 본인 user_id로 row 추가
-- C-5. [ ] 작품함 목록 — 본인 작품만 보임 (다른 user 작품 노출 X)
-- C-6. [ ] 로그아웃 → 다시 카카오 로그인 → 같은 작품함 데이터 복원
-- C-7. [ ] 기존 4명 중 1명 (현지선)으로 로그인 → 자서전 7개 인터뷰 데이터 그대로 보임
-- C-8. [ ] 브라우저 콘솔 Network — supabase 호출이 모두 200/201,
--          PGRST205/RLS 차단 401 없음
-- C-9. [ ] 마이페이지 → 로그아웃 → 비로그인 상태에서
--          /functions/v1/ai-chat 호출 (배포 후) 정상 동작 OR 명시적 401
-- C-10. [ ] ai-donghang-trial.html → 무료 체험 가입 → trial_signups에 row 추가


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ §D. 보안 회귀 — 적용 전 노출 점검 항목                                    │
-- └──────────────────────────────────────────────────────────────────────────┘
-- D-1. [ ] 브라우저에서 익명 모드로 다음 URL 직접 입력 — 모두 빈 배열 또는 차단:
--          {SUPABASE_URL}/rest/v1/profiles?select=*&apikey={ANON_KEY}
--          {SUPABASE_URL}/rest/v1/works?select=*&apikey={ANON_KEY}
--          {SUPABASE_URL}/rest/v1/user_stories?select=*&apikey={ANON_KEY}
--          {SUPABASE_URL}/rest/v1/autobiography_chapters?select=*&apikey={ANON_KEY}
-- D-2. [ ] community_works 와 question_pool 만 공개 SELECT 가능
-- D-3. [ ] anon → INSERT into works 시도 → 401/403 (RLS 차단)


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ §E. 클라이언트 코드 후속 작업 (이 마이그레이션 적용 후 수정 필요)         │
-- └──────────────────────────────────────────────────────────────────────────┘
-- E-1. ai-donghang.html / ai-donghang-member.html / ai-donghang-trial.html:
--      db.from('users')  →  db.from('profiles')
-- E-2. authPhone() / authLoginPhone() 함수를:
--      supabase.auth.signInWithOtp({phone}) 또는
--      supabase.auth.signInWithOAuth({provider:'kakao'}) 로 교체
-- E-3. authKakao() 더미 stub 제거 — 실 OAuth로 교체
-- E-4. works.insert에서 user_id 클라이언트 값 → auth.uid() 자동 주입으로 변경
--      (RLS WITH CHECK가 강제하므로 잘못된 값이면 INSERT 실패)
-- E-5. trial_signups에 'source' 필드 채우는지 확인 (선택)


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ §G. 클라이언트 dual mode 로컬 테스트 (마이그레이션 적용 전 사전 검증)     │
-- └──────────────────────────────────────────────────────────────────────────┘
-- 적용 시점: AUTH_MODE 변경 적용 직후, 마이그레이션 SQL 실행 전.
-- 목적: 'legacy' 모드에서 기존 동작이 유지되는지 (회귀 없는지) 확인.
-- 환경: file:// 또는 로컬 정적 서버 (예: python -m http.server 8000)
--
-- G-1. [ ] ai-donghang.html 콘솔에서 typeof AUTH_MODE 입력 → 'string' 반환
--          AUTH_MODE 값이 'legacy' 인지 확인
-- G-2. [ ] 콘솔 에러 없이 페이지 로드 완료
-- G-3. [ ] [legacy] 카카오 가입 버튼 클릭 → "환영해요" 모달 → 마이페이지 진입
--          (현재와 100% 동일한 동작, dummy stub 유지)
-- G-4. [ ] [legacy] 전화번호 가입: 이름+010-XXXX-XXXX 입력 → 가입 처리
--          → Network 탭에서 profiles 404 확인 → catch 폴백 → localStorage 프로필 생성
--          (현재와 동일: profiles 테이블 없으니 404, 폴백 작동)
-- G-5. [ ] [legacy] 작품 빌더에서 결과 생성 → 작품함에 저장
--          → 작품함 목록에 추가 (localStorage 기반)
--          → Network 탭: works.insert는 4xx (DB 권한 또는 컬럼 미일치) 가능
--          (현재와 동일: catch 흡수)
-- G-6. [ ] [legacy] 로그아웃 → 토스트 → 홈 화면 + 로그아웃 상태 nav
-- G-7. [ ] ai-donghang-member.html 도 G-3 ~ G-6 동일 검증
--
-- 다음 단계 — AUTH_MODE='supabase_auth'로 플립 + 마이그레이션 적용 후:
-- G-8. [ ] 페이지 로드 시 db.auth.onAuthStateChange 등록 (콘솔 에러 없음)
-- G-9. [ ] [supabase_auth] 카카오 버튼 → 실제 카카오 OAuth 페이지 redirect
-- G-10.[ ] OAuth 성공 후 콜백 → profiles 조회 → showAuthSuccess → 마이페이지
-- G-11.[ ] [supabase_auth] 전화 가입/로그인 버튼 → "준비 중" 토스트만 표시
-- G-12.[ ] [supabase_auth] 작품 저장 → auth.getUser() 사용 → RLS 통과
-- G-13.[ ] [supabase_auth] 로그아웃 → db.auth.signOut() → SIGNED_OUT 이벤트
--          → localStorage 정리


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ §F. 적용 직후 모니터링 (24시간)                                           │
-- └──────────────────────────────────────────────────────────────────────────┘
-- F-1. [ ] Supabase 대시보드 Logs → Edge Functions / Postgres 에러 급증 없음
-- F-2. [ ] 4명 중 활성 사용자 (현지선) 재로그인 성공
-- F-3. [ ] 신규 가입 시도 — 카카오 OAuth로 auth.users + profiles 자동 생성
-- F-4. [ ] 자서전 인터뷰 흐름 (출처 미상) 에러 없는지 — service_role 사용 여부 확인
