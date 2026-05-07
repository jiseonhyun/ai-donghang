-- ============================================================
-- AI 동행 — 약관 동의 컬럼 추가 (한국 개인정보보호법 준수)
-- 적용 일자: 2026-05-07
-- 적용 위치: Supabase 프로젝트 SQL Editor
-- ============================================================
--
-- 한국 개인정보보호법(개보법)에 따라 회원가입 시 다음 동의를
-- 별도로 받아 보관해야 합니다:
--   1) 만 14세 이상 확인 (필수)
--   2) 이용약관 동의 (필수)
--   3) 개인정보 수집·이용 동의 (필수)
--   4) 마케팅 정보 수신 동의 (선택)
--
-- 본 마이그레이션은 "Users" 테이블(대문자 U)에 6개 컬럼을 추가합니다.
-- 기존 회원에게도 다음 로그인 시 동의를 받도록 클라이언트 측에서 처리합니다.
-- ============================================================

ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS agreed_age_14       BOOLEAN     DEFAULT FALSE;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS agreed_terms_at     TIMESTAMPTZ;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS agreed_privacy_at   TIMESTAMPTZ;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS agreed_marketing    BOOLEAN     DEFAULT FALSE;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS agreed_marketing_at TIMESTAMPTZ;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS terms_version       TEXT        DEFAULT '1.0';

-- 컬럼 코멘트 (Supabase Studio 에서 사람이 읽을 수 있게)
COMMENT ON COLUMN "Users".agreed_age_14       IS '만 14세 이상 동의 (필수)';
COMMENT ON COLUMN "Users".agreed_terms_at     IS '이용약관 동의 시각 (필수)';
COMMENT ON COLUMN "Users".agreed_privacy_at   IS '개인정보 수집·이용 동의 시각 (필수)';
COMMENT ON COLUMN "Users".agreed_marketing    IS '마케팅 정보 수신 동의 여부 (선택)';
COMMENT ON COLUMN "Users".agreed_marketing_at IS '마케팅 동의 시각 (동의 시에만 채움)';
COMMENT ON COLUMN "Users".terms_version       IS '동의 시점의 약관 버전 (예: 1.0)';

-- 약관 미동의 사용자 빠르게 조회하기 위한 인덱스 (선택)
CREATE INDEX IF NOT EXISTS idx_users_agreed_terms_at ON "Users" (agreed_terms_at);

-- ============================================================
-- 검증 쿼리 (적용 후 실행해서 확인)
-- ============================================================
--
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'Users'
--   AND column_name IN ('agreed_age_14','agreed_terms_at','agreed_privacy_at',
--                       'agreed_marketing','agreed_marketing_at','terms_version');
--
-- 약관 미동의 사용자 수:
-- SELECT COUNT(*) FROM "Users" WHERE agreed_terms_at IS NULL;
