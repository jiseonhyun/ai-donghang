-- ============================================================================
-- Phase B: Supabase Auth 전면 이전 + RLS 하드닝
-- ============================================================================
-- 작성일: 2026-05-18
-- 사전 요구사항 (이 마이그레이션 적용 전 반드시 완료):
--   1. Supabase 대시보드 Authentication → Providers → Kakao 활성화
--   2. supabase/scripts/phase_b_pre_migrate.mjs 실행하여:
--      (a) 기존 public.Users 4명을 auth.users로 생성
--      (b) public._migration_user_id_map 테이블 생성 + 매핑 INSERT
-- 적용: supabase db push (CLI 자동화)
-- 롤백: supabase/scripts/phase_b_rollback.sql 참고
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- STEP 0: 사전 조건 검증
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  users_count int;
  map_count int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = '_migration_user_id_map'
  ) THEN
    RAISE EXCEPTION 'Precondition failed: _migration_user_id_map missing. '
      'Run supabase/scripts/phase_b_pre_migrate.mjs first.';
  END IF;

  SELECT COUNT(*) INTO users_count FROM public."Users";
  SELECT COUNT(*) INTO map_count FROM public._migration_user_id_map;

  IF users_count <> map_count THEN
    RAISE EXCEPTION 'Precondition failed: Users (%) != mapping (%). '
      'Re-run pre-migrate script.', users_count, map_count;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- STEP 1: public.profiles 신규 (Users 후속)
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- STEP 2: 기존 Users 데이터 → profiles (매핑 사용)
-- ----------------------------------------------------------------------------
INSERT INTO public.profiles (
  id, name, phone, kakao_id, plan,
  last_question_shown_at, last_question_id,
  agreed_age_14, agreed_terms_at, agreed_privacy_at,
  agreed_marketing, agreed_marketing_at, terms_version, created_at
)
SELECT
  m.new_uuid,
  u.name, u.phone, u.kakao_id, COALESCE(u.plan,'free'),
  u.last_question_shown_at, u.last_question_id,
  COALESCE(u.agreed_age_14,false), u.agreed_terms_at, u.agreed_privacy_at,
  COALESCE(u.agreed_marketing,false), u.agreed_marketing_at,
  COALESCE(u.terms_version,'1.0'), COALESCE(u.created_at, now())
FROM public."Users" u
JOIN public._migration_user_id_map m ON m.old_id = u.id
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- STEP 3: 자식 테이블 user_id 컬럼 bigint → uuid
-- ----------------------------------------------------------------------------

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

-- 3-3. user_progress (user_id이 PK)
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

-- ----------------------------------------------------------------------------
-- STEP 4: handle_new_user 트리거 (auth.users INSERT 시 profiles 자동 생성)
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- STEP 5: trial_signups 테이블 신규 (코드에 호출 있는데 DB 부재였던 버그)
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- STEP 6: RLS 활성화 + 정책 적용
-- ----------------------------------------------------------------------------

-- profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_self_select ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id);
CREATE POLICY profiles_self_update ON public.profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);
-- INSERT: handle_new_user trigger(SECURITY DEFINER)만 / DELETE: cascade only

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

-- user_stories (출처 미상 → 쓰기는 service_role 전용)
ALTER TABLE public.user_stories ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_stories_self_select ON public.user_stories
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
-- INSERT/UPDATE/DELETE 정책 없음 → service_role만 가능

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

-- autobiography_sessions (course 소유자만 SELECT, 쓰기는 service_role)
ALTER TABLE public.autobiography_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY autobiography_sessions_owner_select ON public.autobiography_sessions
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.autobiography_courses c
      WHERE c.id = autobiography_sessions.course_id
        AND c.user_id = auth.uid()
    )
  );

-- autobiography_chapters (course 소유자만 SELECT, 쓰기는 service_role)
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
-- 쓰기는 service_role만

-- Prompts (대문자, service_role 전용)
ALTER TABLE public."Prompts" ENABLE ROW LEVEL SECURITY;
-- 정책 없음 → service_role만 접근 가능

-- trial_signups (가입 시도 — anon INSERT 허용, SELECT/UPDATE/DELETE는 service_role)
ALTER TABLE public.trial_signups ENABLE ROW LEVEL SECURITY;
CREATE POLICY trial_signups_anon_insert ON public.trial_signups
  FOR INSERT TO anon, authenticated WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- STEP 7: 기존 Users + 매핑 테이블 정리
-- ----------------------------------------------------------------------------
DROP TABLE public."Users" CASCADE;
DROP TABLE public._migration_user_id_map;

COMMIT;

-- ============================================================================
-- 적용 후 확인:
--   SELECT COUNT(*) FROM public.profiles;        -- 4 (기존 Users 인원수)
--   SELECT COUNT(*) FROM auth.users;             -- 4 이상 (사전 생성 + 신규)
--   SELECT * FROM pg_policies WHERE schemaname='public';  -- 정책 일람
--   SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace;
-- ============================================================================
