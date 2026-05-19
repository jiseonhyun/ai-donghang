-- ============================================================================
-- Phase B 롤백 SQL
-- ============================================================================
-- ⚠️ 경고:
--   이 롤백은 "구조만" 되돌립니다. 마이그레이션 중에 auth.users로 들어간
--   기존 4명 계정 + 그들이 만든 Phase B 이후 신규 데이터는 손실됩니다.
--   심각한 문제 발생 시 Supabase 대시보드의 Point-In-Time Recovery(PITR)로
--   백업 시점 복원이 더 안전합니다.
--
-- 적용 전 백업: pg_dump 또는 Supabase 대시보드 Database → Backups
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. handle_new_user 트리거 + 함수 제거
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 2. RLS 정책 일괄 제거 + RLS 비활성화
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                   r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

ALTER TABLE public.profiles                DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.works                   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_stories            DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_progress           DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.autobiography_courses   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.autobiography_sessions  DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.autobiography_chapters  DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_works         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_pool           DISABLE ROW LEVEL SECURITY;
ALTER TABLE public."Prompts"               DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.trial_signups           DISABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 3. Users 테이블 복원 (스키마만)
-- ----------------------------------------------------------------------------
CREATE TABLE public."Users" (
  id                      bigserial PRIMARY KEY,
  name                    text,
  phone                   text,
  kakao_id                text,
  plan                    text DEFAULT 'free',
  created_at              timestamptz DEFAULT now(),
  last_question_shown_at  timestamptz,
  last_question_id        bigint,
  agreed_age_14           boolean,
  agreed_terms_at         timestamptz,
  agreed_privacy_at       timestamptz,
  agreed_marketing        boolean DEFAULT false,
  agreed_marketing_at     timestamptz,
  terms_version           text DEFAULT '1.0'
);

-- 4. profiles 데이터를 Users로 복사 (UUID는 사라지고 새 bigserial 할당)
INSERT INTO public."Users" (
  name, phone, kakao_id, plan, created_at,
  last_question_shown_at, last_question_id,
  agreed_age_14, agreed_terms_at, agreed_privacy_at,
  agreed_marketing, agreed_marketing_at, terms_version
)
SELECT
  name, phone, kakao_id, plan, created_at,
  last_question_shown_at, last_question_id,
  agreed_age_14, agreed_terms_at, agreed_privacy_at,
  agreed_marketing, agreed_marketing_at, terms_version
FROM public.profiles;

-- ----------------------------------------------------------------------------
-- 5. 자식 테이블 FK 컬럼 uuid → bigint 역마이그레이션
--    profiles.id ↔ "Users".id 매핑 임시 테이블 사용
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE _rollback_map (
  new_uuid uuid PRIMARY KEY,
  old_id   bigint NOT NULL UNIQUE
);

-- profiles와 "Users"를 phone 또는 kakao_id로 매칭해 매핑 생성
INSERT INTO _rollback_map (new_uuid, old_id)
SELECT p.id, u.id
FROM public.profiles p
JOIN public."Users" u ON
  (p.phone IS NOT NULL AND p.phone = u.phone)
  OR (p.kakao_id IS NOT NULL AND p.kakao_id = u.kakao_id);

-- works
ALTER TABLE public.works DROP CONSTRAINT IF EXISTS works_user_id_fkey;
ALTER TABLE public.works ADD COLUMN user_id_old bigint;
UPDATE public.works w SET user_id_old = r.old_id
FROM _rollback_map r WHERE w.user_id = r.new_uuid;
ALTER TABLE public.works DROP COLUMN user_id;
ALTER TABLE public.works RENAME COLUMN user_id_old TO user_id;

-- user_stories
ALTER TABLE public.user_stories DROP CONSTRAINT IF EXISTS user_stories_user_id_fkey;
ALTER TABLE public.user_stories ADD COLUMN user_id_old bigint;
UPDATE public.user_stories us SET user_id_old = r.old_id
FROM _rollback_map r WHERE us.user_id = r.new_uuid;
ALTER TABLE public.user_stories DROP COLUMN user_id;
ALTER TABLE public.user_stories RENAME COLUMN user_id_old TO user_id;

-- user_progress (PK)
ALTER TABLE public.user_progress DROP CONSTRAINT IF EXISTS user_progress_user_id_fkey;
ALTER TABLE public.user_progress DROP CONSTRAINT IF EXISTS user_progress_pkey;
ALTER TABLE public.user_progress ADD COLUMN user_id_old bigint;
UPDATE public.user_progress up SET user_id_old = r.old_id
FROM _rollback_map r WHERE up.user_id = r.new_uuid;
ALTER TABLE public.user_progress DROP COLUMN user_id;
ALTER TABLE public.user_progress RENAME COLUMN user_id_old TO user_id;
ALTER TABLE public.user_progress ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE public.user_progress ADD PRIMARY KEY (user_id);

-- autobiography_courses
ALTER TABLE public.autobiography_courses DROP CONSTRAINT IF EXISTS autobiography_courses_user_id_fkey;
ALTER TABLE public.autobiography_courses ADD COLUMN user_id_old bigint;
UPDATE public.autobiography_courses ac SET user_id_old = r.old_id
FROM _rollback_map r WHERE ac.user_id = r.new_uuid;
ALTER TABLE public.autobiography_courses DROP COLUMN user_id;
ALTER TABLE public.autobiography_courses RENAME COLUMN user_id_old TO user_id;

-- community_works
ALTER TABLE public.community_works DROP CONSTRAINT IF EXISTS community_works_user_id_fkey;
ALTER TABLE public.community_works ADD COLUMN user_id_old bigint;
UPDATE public.community_works cw SET user_id_old = r.old_id
FROM _rollback_map r WHERE cw.user_id = r.new_uuid;
ALTER TABLE public.community_works DROP COLUMN user_id;
ALTER TABLE public.community_works RENAME COLUMN user_id_old TO user_id;

-- ----------------------------------------------------------------------------
-- 6. profiles 제거 (CASCADE로 auth.users → profiles FK 도 해제)
-- ----------------------------------------------------------------------------
DROP TABLE public.profiles CASCADE;

-- ----------------------------------------------------------------------------
-- 7. trial_signups 제거 (Phase B에서 신규 생성된 테이블)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.trial_signups;

COMMIT;

-- ============================================================================
-- 별도 처리 필요:
--   - auth.users의 마이그레이션된 4개 row는 자동 삭제되지 않음.
--     필요 시 Supabase 대시보드 Authentication → Users에서 수동 삭제.
--   - Authentication → Providers → Kakao 설정은 비활성화하지 않음
--     (다음 시도에 재사용 가능).
-- ============================================================================
