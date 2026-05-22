-- ============================================================================
-- 옵션 C: 기존 4명 + 테스트 데이터 모두 삭제 후 Phase B 마이그레이션
-- ============================================================================
-- 작성일: 2026-05-19
-- 전제: 외부 회원 없음. Anna(id=1) 데이터는 BACKUP_Anna_2026-05-19.md에 백업 완료.
-- 적용 위치: Supabase 대시보드 > SQL Editor (gaibakqhdfdpnsdgpmya 프로젝트)
-- 적용 방법:
--   - SECTION 1 → RUN → 결과 확인
--   - SECTION 2 → RUN → 결과 확인
--   - SECTION 3 → RUN → 결과 확인
--   - 마지막 검증 쿼리 RUN
--   각 SECTION은 독립 트랜잭션이라 중간 단계에서 멈춰도 안전합니다.
-- 롤백: supabase/scripts/phase_b_rollback.sql 참고 (Phase B 적용 후 한정)
-- ============================================================================



-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SECTION 1 — 테스트 데이터 비우기 (보존: question_pool, Prompts)            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

-- 자식 테이블 먼저 비우기 (TRUNCATE CASCADE로 FK 연쇄도 안전)
TRUNCATE TABLE
  public.user_stories,
  public.works,
  public.user_progress,
  public.autobiography_chapters,
  public.autobiography_sessions,
  public.autobiography_courses,
  public.community_works
CASCADE;

-- Users 테이블 비우기
DELETE FROM public."Users";

COMMIT;

-- ─ 확인 쿼리 (모두 0이면 SECTION 1 성공) ────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM public."Users")                    AS users,
  (SELECT COUNT(*) FROM public.user_stories)               AS stories,
  (SELECT COUNT(*) FROM public.works)                      AS works,
  (SELECT COUNT(*) FROM public.user_progress)              AS progress,
  (SELECT COUNT(*) FROM public.autobiography_courses)      AS auto_courses,
  (SELECT COUNT(*) FROM public.autobiography_sessions)     AS auto_sessions,
  (SELECT COUNT(*) FROM public.autobiography_chapters)     AS auto_chapters,
  (SELECT COUNT(*) FROM public.community_works)            AS community,
  (SELECT COUNT(*) FROM public.question_pool)              AS questions_preserved;
-- 예상 결과: 모두 0, questions_preserved = 55 (보존됨)



-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SECTION 2 — 빈 매핑 테이블 생성 (Phase B SQL의 STEP 0 사전조건 통과용)     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

CREATE TABLE IF NOT EXISTS public._migration_user_id_map (
  old_id   bigint PRIMARY KEY,
  new_uuid uuid   NOT NULL UNIQUE
);

COMMIT;

-- ─ 확인 쿼리 (테이블 존재 + 0행) ────────────────────────────────────────────
SELECT
  EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='_migration_user_id_map'
  ) AS map_table_exists,
  (SELECT COUNT(*) FROM public._migration_user_id_map) AS map_rows;
-- 예상 결과: map_table_exists=true, map_rows=0



-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SECTION 3 — Phase B 메인 마이그레이션 (auth.users + RLS + profiles)        ║
-- ║ (원본: supabase/migrations/20260518000000_phase_b_supabase_auth_rls.sql)   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

-- ── STEP 0: 사전 조건 검증 (Users 0행 == map 0행이라 통과) ──────────────────
DO $$
DECLARE
  users_count int;
  map_count int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = '_migration_user_id_map'
  ) THEN
    RAISE EXCEPTION 'Precondition failed: _migration_user_id_map missing. Run SECTION 2 first.';
  END IF;

  SELECT COUNT(*) INTO users_count FROM public."Users";
  SELECT COUNT(*) INTO map_count FROM public._migration_user_id_map;

  IF users_count <> map_count THEN
    RAISE EXCEPTION 'Precondition failed: Users (%) != mapping (%). Re-run SECTION 1+2.', users_count, map_count;
  END IF;
END $$;

-- ── STEP 1: public.profiles 신규 (Users 후속) ───────────────────────────────
CREATE TABLE public.profiles (
  id                      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name                    text,
  phone                   text UNIQUE,
  kakao_id                text UNIQUE,
  plan                    text DEFAULT 'free' CHECK (plan IN ('free','paid','plus','b2g')),
  last_question_shown_at  timestamptz,
  last_question_id        bigint,
  agreed_age_14           boolean DEFAULT false,
  agreed_terms_at         timestamptz,
  agreed_privacy_at       timestamptz,
  agreed_marketing        boolean DEFAULT false,
  agreed_marketing_at     timestamptz,
  terms_version           text DEFAULT '1.0',
  created_at              timestamptz DEFAULT now()
);

CREATE INDEX idx_profiles_phone    ON public.profiles (phone);
CREATE INDEX idx_profiles_kakao_id ON public.profiles (kakao_id);

-- ── STEP 2: 기존 Users → profiles 복사 ──────────────────────────────────────
-- 옵션 C에서는 Users 테이블이 비어 있으므로 INSERT 자체 불필요.
-- 일반화된 phase_b SQL 원본의 INSERT … SELECT 절은 일부 컬럼(예: created_at)이
-- 실제 DB에서 text 로 저장돼 있어 COALESCE 타입 매칭(text vs timestamptz) 컴파일
-- 단계에서 실패. Users 가 비어 있어 어차피 0행 처리될 거라 통째로 생략하는 게
-- 안전. 향후 데이터 인계가 필요한 마이그에서는 phase_b_pre_migrate.mjs 흐름을
-- 거치며 각 컬럼을 명시 CAST 한 별도 SQL 을 작성할 것.
-- (옛 코드: INSERT INTO public.profiles ... SELECT ... FROM public."Users")

-- ── STEP 3: 자식 테이블 user_id 컬럼 bigint → uuid ──────────────────────────
-- 자식 테이블이 비어 있으므로 UPDATE 대상 0행, DROP/RENAME만 작용

-- 3-1. works
ALTER TABLE public.works ADD COLUMN user_id_new uuid;
UPDATE public.works w
SET user_id_new = m.new_uuid
FROM public._migration_user_id_map m
WHERE w.user_id = m.old_id;
ALTER TABLE public.works DROP COLUMN user_id;
ALTER TABLE public.works RENAME COLUMN user_id_new TO user_id;
ALTER TABLE public.works
  ADD CONSTRAINT works_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
CREATE INDEX idx_works_user_id ON public.works(user_id);

-- 3-2. user_stories
ALTER TABLE public.user_stories ADD COLUMN user_id_new uuid;
UPDATE public.user_stories us
SET user_id_new = m.new_uuid
FROM public._migration_user_id_map m
WHERE us.user_id = m.old_id;
ALTER TABLE public.user_stories DROP COLUMN user_id;
ALTER TABLE public.user_stories RENAME COLUMN user_id_new TO user_id;
ALTER TABLE public.user_stories
  ADD CONSTRAINT user_stories_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
CREATE INDEX idx_user_stories_user_id ON public.user_stories(user_id);

-- 3-3. user_progress (user_id이 PK — 자식 테이블 비어있어야 NULL 충돌 없음)
ALTER TABLE public.user_progress ADD COLUMN user_id_new uuid;
UPDATE public.user_progress up
SET user_id_new = m.new_uuid
FROM public._migration_user_id_map m
WHERE up.user_id = m.old_id;
ALTER TABLE public.user_progress DROP CONSTRAINT IF EXISTS user_progress_pkey;
ALTER TABLE public.user_progress DROP COLUMN user_id;
ALTER TABLE public.user_progress RENAME COLUMN user_id_new TO user_id;
ALTER TABLE public.user_progress ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE public.user_progress ADD PRIMARY KEY (user_id);
ALTER TABLE public.user_progress
  ADD CONSTRAINT user_progress_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- 3-4. autobiography_courses
ALTER TABLE public.autobiography_courses ADD COLUMN user_id_new uuid;
UPDATE public.autobiography_courses ac
SET user_id_new = m.new_uuid
FROM public._migration_user_id_map m
WHERE ac.user_id = m.old_id;
ALTER TABLE public.autobiography_courses DROP COLUMN user_id;
ALTER TABLE public.autobiography_courses RENAME COLUMN user_id_new TO user_id;
ALTER TABLE public.autobiography_courses
  ADD CONSTRAINT autobiography_courses_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
CREATE INDEX idx_autobiography_courses_user_id ON public.autobiography_courses(user_id);

-- 3-5. community_works
ALTER TABLE public.community_works ADD COLUMN user_id_new uuid;
UPDATE public.community_works cw
SET user_id_new = m.new_uuid
FROM public._migration_user_id_map m
WHERE cw.user_id = m.old_id;
ALTER TABLE public.community_works DROP COLUMN user_id;
ALTER TABLE public.community_works RENAME COLUMN user_id_new TO user_id;
ALTER TABLE public.community_works
  ADD CONSTRAINT community_works_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
CREATE INDEX idx_community_works_user_id ON public.community_works(user_id);

-- ── STEP 4: handle_new_user 트리거 (auth.users INSERT → profiles 자동 생성) ─
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (
    id, name, kakao_id, phone,
    agreed_age_14, agreed_terms_at, agreed_privacy_at, terms_version
  )
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data ->> 'name',
      NEW.raw_user_meta_data ->> 'nickname',
      '동행 사용자'
    ),
    NEW.raw_user_meta_data ->> 'provider_id',
    NEW.phone,
    true, now(), now(), '1.0'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── STEP 5: trial_signups 테이블 신규 ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trial_signups (
  id          bigserial PRIMARY KEY,
  name        text,
  phone       text,
  email       text,
  interest    text,
  trial_done  jsonb,
  source      text,
  created_at  timestamptz DEFAULT now()
);

-- ── STEP 6: RLS 활성화 + 정책 적용 ──────────────────────────────────────────

-- profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_self_select ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id);
CREATE POLICY profiles_self_update ON public.profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- works
ALTER TABLE public.works ENABLE ROW LEVEL SECURITY;
CREATE POLICY works_self_select ON public.works
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY works_self_insert ON public.works
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY works_self_update ON public.works
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY works_self_delete ON public.works
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- user_stories (쓰기는 service_role 전용)
ALTER TABLE public.user_stories ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_stories_self_select ON public.user_stories
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- user_progress
ALTER TABLE public.user_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_progress_self_select ON public.user_progress
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY user_progress_self_insert ON public.user_progress
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY user_progress_self_update ON public.user_progress
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- autobiography_courses (쓰기는 service_role 전용)
ALTER TABLE public.autobiography_courses ENABLE ROW LEVEL SECURITY;
CREATE POLICY autobiography_courses_self_select ON public.autobiography_courses
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- autobiography_sessions (course 소유자만 SELECT)
ALTER TABLE public.autobiography_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY autobiography_sessions_owner_select ON public.autobiography_sessions
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.autobiography_courses c
      WHERE c.id = autobiography_sessions.course_id
        AND c.user_id = auth.uid()
    )
  );

-- autobiography_chapters (course 소유자만 SELECT)
ALTER TABLE public.autobiography_chapters ENABLE ROW LEVEL SECURITY;
CREATE POLICY autobiography_chapters_owner_select ON public.autobiography_chapters
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.autobiography_courses c
      WHERE c.id = autobiography_chapters.course_id
        AND c.user_id = auth.uid()
    )
  );

-- community_works (공개 SELECT, 본인만 쓰기)
ALTER TABLE public.community_works ENABLE ROW LEVEL SECURITY;
CREATE POLICY community_works_public_select ON public.community_works
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY community_works_self_insert ON public.community_works
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY community_works_self_update ON public.community_works
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY community_works_self_delete ON public.community_works
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- question_pool (공개 참조 데이터)
ALTER TABLE public.question_pool ENABLE ROW LEVEL SECURITY;
CREATE POLICY question_pool_public_select ON public.question_pool
  FOR SELECT TO anon, authenticated USING (is_active = true);

-- Prompts (service_role 전용)
ALTER TABLE public."Prompts" ENABLE ROW LEVEL SECURITY;

-- trial_signups (anon INSERT 허용)
ALTER TABLE public.trial_signups ENABLE ROW LEVEL SECURITY;
CREATE POLICY trial_signups_anon_insert ON public.trial_signups
  FOR INSERT TO anon, authenticated WITH CHECK (true);

-- ── STEP 7: 기존 Users + 매핑 테이블 정리 ───────────────────────────────────
DROP TABLE public."Users" CASCADE;
DROP TABLE public._migration_user_id_map;

COMMIT;



-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ FINAL — 마이그레이션 결과 검증 (모든 SECTION 이후 실행)                    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- 1) profiles / auth.users 행 수 (둘 다 0이면 OK — 아직 사용자 없음)
SELECT
  (SELECT COUNT(*) FROM public.profiles)  AS profiles,
  (SELECT COUNT(*) FROM auth.users)       AS auth_users;

-- 2) Users 테이블 사라졌는지
SELECT NOT EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema='public' AND table_name='Users'
) AS users_table_dropped;

-- 3) 매핑 테이블 사라졌는지
SELECT NOT EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema='public' AND table_name='_migration_user_id_map'
) AS map_table_dropped;

-- 4) RLS 활성화된 테이블 목록 (11개 모두 t 여야 함)
SELECT relname AS table_name, relrowsecurity AS rls_enabled
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relkind = 'r'
  AND relname IN (
    'profiles','works','user_stories','user_progress',
    'autobiography_courses','autobiography_sessions','autobiography_chapters',
    'community_works','question_pool','Prompts','trial_signups'
  )
ORDER BY relname;

-- 5) 정책 일람 (각 테이블에 정책이 잡혀있는지 확인)
SELECT schemaname, tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- 6) handle_new_user 트리거 존재 확인
SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgname = 'on_auth_user_created';

-- 7) 신규 user_id 컬럼이 uuid 타입인지 확인
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema='public'
  AND column_name='user_id'
  AND table_name IN ('works','user_stories','user_progress','autobiography_courses','community_works')
ORDER BY table_name;
-- 예상: 모두 data_type='uuid'

-- ============================================================================
-- 다음 단계 (이 파일과는 별개 작업)
--   1) Supabase 대시보드 > Authentication > Providers > Kakao 활성화 확인
--   2) ai-donghang.html 에 const AUTH_MODE='supabase' 추가
--   3) authKakao() 등 인증 흐름을 supabase.auth.* API로 교체
--   4) db.from('Users') → db.from('profiles') 일괄 교체
-- ============================================================================
