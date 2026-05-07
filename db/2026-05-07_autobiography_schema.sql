-- ============================================================
-- AI 동행 — 자서전 인터뷰 시스템 v3 스키마
-- 적용 일자: 2026-05-07
-- 적용 위치: Supabase 프로젝트 SQL Editor
-- ============================================================
--
-- 자서전 v3는 8주 × 90분 다회차 인터뷰 방식이며 다음 5개 테이블로 구성됩니다:
--   1) autobiography_courses     — 코스 인스턴스 (사용자 1명당 1+개)
--   2) autobiography_sessions    — 회차 (1-8회, 코스당 8 row)
--   3) autobiography_episodes    — 에피소드 (회차 내 대화 누적, 6단계 진행)
--   4) autobiography_chapters    — 완성된 장 본문 (AI 생성, works 테이블에도 거울 저장)
--   5) autobiography_class_codes — 강사 코드 (강의실 모드 진입용)
--
-- 정책:
-- - "Users" 테이블(대문자 U)을 FK 참조 — 기존 컨벤션 유지
-- - RLS는 기존 works/Users 와 동일하게 OFF (서버 측 권한 제어)
-- - ON DELETE CASCADE 사용 — 회원 탈퇴 시 자서전 데이터도 함께 파기 (개보법 준수)
-- - IF NOT EXISTS 모든 DDL에 적용 — 여러 번 실행해도 안전 (idempotent)
-- ============================================================

-- ─────────────────────────────────────────────
-- 테이블 1: autobiography_courses
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS autobiography_courses (
  id                          BIGSERIAL PRIMARY KEY,
  user_id                     BIGINT NOT NULL REFERENCES "Users"(id) ON DELETE CASCADE,
  course_type                 TEXT NOT NULL CHECK (course_type IN ('classroom','solo')),
  class_code                  TEXT,
  started_at                  TIMESTAMPTZ DEFAULT NOW(),
  completed_at                TIMESTAMPTZ,
  current_session             INT DEFAULT 1 CHECK (current_session BETWEEN 1 AND 8),
  pace_score                  REAL DEFAULT 0.5 CHECK (pace_score BETWEEN 0 AND 1),
  selected_optional_chapters  TEXT[] DEFAULT ARRAY[]::TEXT[],
  ethics_agreed_at            TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE  autobiography_courses                            IS '자서전 v3 코스 인스턴스 (사용자별)';
COMMENT ON COLUMN autobiography_courses.user_id                    IS '회원 ID (Users.id 참조)';
COMMENT ON COLUMN autobiography_courses.course_type                IS '강의실(classroom) / 혼자(solo)';
COMMENT ON COLUMN autobiography_courses.class_code                 IS '강의실 모드 진입 시 입력한 강사 코드 (solo는 NULL)';
COMMENT ON COLUMN autobiography_courses.current_session            IS '현재 진행 중인 회차 번호 (1-8)';
COMMENT ON COLUMN autobiography_courses.pace_score                 IS '페이스 점수 0~1 (낮을수록 느림). 8회차 분기 결정용';
COMMENT ON COLUMN autobiography_courses.selected_optional_chapters IS '선택한 선택 장 (자녀양육/직업여정/신앙봉사/우정/취미/사회운동 중 1-2)';
COMMENT ON COLUMN autobiography_courses.ethics_agreed_at           IS '자서전 추가 윤리·면책 동의 시각';

CREATE INDEX IF NOT EXISTS idx_autobio_courses_user_id    ON autobiography_courses (user_id);
CREATE INDEX IF NOT EXISTS idx_autobio_courses_class_code ON autobiography_courses (class_code) WHERE class_code IS NOT NULL;

-- ─────────────────────────────────────────────
-- 테이블 2: autobiography_sessions
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS autobiography_sessions (
  id              BIGSERIAL PRIMARY KEY,
  course_id       BIGINT NOT NULL REFERENCES autobiography_courses(id) ON DELETE CASCADE,
  session_number  INT NOT NULL CHECK (session_number BETWEEN 1 AND 8),
  chapter_title   TEXT NOT NULL,
  status          TEXT DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','completed')),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  progress_rate   REAL DEFAULT 0 CHECK (progress_rate BETWEEN 0 AND 1),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (course_id, session_number)
);

COMMENT ON TABLE  autobiography_sessions                IS '자서전 회차 (1-8회). 코스 시작 시 8 row 일괄 생성';
COMMENT ON COLUMN autobiography_sessions.session_number IS '회차 번호 (1=내 이름 / 2=어린시절 / ... / 8=마무리)';
COMMENT ON COLUMN autobiography_sessions.chapter_title  IS '회차 제목 (예: "내 이름 이야기")';
COMMENT ON COLUMN autobiography_sessions.status         IS 'not_started / in_progress / completed';
COMMENT ON COLUMN autobiography_sessions.progress_rate  IS '회차 내 진행률 0~1 (에피소드 완료 비율)';

CREATE INDEX IF NOT EXISTS idx_autobio_sessions_course_id ON autobiography_sessions (course_id);
CREATE INDEX IF NOT EXISTS idx_autobio_sessions_status    ON autobiography_sessions (status);

-- ─────────────────────────────────────────────
-- 테이블 3: autobiography_episodes
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS autobiography_episodes (
  id                  BIGSERIAL PRIMARY KEY,
  session_id          BIGINT NOT NULL REFERENCES autobiography_sessions(id) ON DELETE CASCADE,
  episode_title       TEXT,
  messages            JSONB DEFAULT '[]'::jsonb,
  six_stage_progress  JSONB DEFAULT '{"scene":false,"sense":false,"people":false,"event":false,"emotion":false,"meaning":false}'::jsonb,
  completed           BOOLEAN DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE  autobiography_episodes                    IS '에피소드 — 한 회차 내 1-2개 에피소드, 각 에피소드는 6단계 점진 심화';
COMMENT ON COLUMN autobiography_episodes.messages           IS '대화 누적 [{role:"assistant"|"user", content:"...", at:"ISO8601"}, ...]';
COMMENT ON COLUMN autobiography_episodes.six_stage_progress IS '6단계 진행 상태 — 장면/감각/사람/사건/감정/의미 boolean';
COMMENT ON COLUMN autobiography_episodes.completed          IS '에피소드 종료 여부 ([INTERVIEW_END] 토큰 수신 시 true)';

CREATE INDEX IF NOT EXISTS idx_autobio_episodes_session_id ON autobiography_episodes (session_id);

-- ─────────────────────────────────────────────
-- 테이블 4: autobiography_chapters
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS autobiography_chapters (
  id              BIGSERIAL PRIMARY KEY,
  course_id       BIGINT NOT NULL REFERENCES autobiography_courses(id) ON DELETE CASCADE,
  chapter_number  INT NOT NULL CHECK (chapter_number BETWEEN 1 AND 9),
  chapter_title   TEXT NOT NULL,
  content         TEXT NOT NULL,
  era_box         TEXT,
  works_id        BIGINT,
  generated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (course_id, chapter_number)
);

COMMENT ON TABLE  autobiography_chapters                IS '완성된 장 본문 (AI가 인터뷰 종료 시 생성). 작품함은 works에 거울 저장';
COMMENT ON COLUMN autobiography_chapters.chapter_number IS '장 번호 (1-7 필수 + 8 선택장 + 9 마무리/헌사)';
COMMENT ON COLUMN autobiography_chapters.content        IS '본문 (본인 답변 70%↑ + AI 풍부화 30%↓)';
COMMENT ON COLUMN autobiography_chapters.era_box        IS '시대 배경 정보 (본문과 분리, 별도 박스로 표시)';
COMMENT ON COLUMN autobiography_chapters.works_id       IS '작품함(works) 거울 저장 row id (NULL 가능)';

CREATE INDEX IF NOT EXISTS idx_autobio_chapters_course_id ON autobiography_chapters (course_id);

-- ─────────────────────────────────────────────
-- 테이블 5: autobiography_class_codes
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS autobiography_class_codes (
  id               BIGSERIAL PRIMARY KEY,
  code             TEXT UNIQUE NOT NULL,
  instructor_name  TEXT NOT NULL,
  max_students     INT DEFAULT 10 CHECK (max_students > 0),
  schedule         TEXT,
  active           BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE  autobiography_class_codes                 IS '강사 코드 — 강의실 모드 진입 시 검증';
COMMENT ON COLUMN autobiography_class_codes.code            IS '강사가 학생에게 공유하는 코드 (영숫자, UNIQUE)';
COMMENT ON COLUMN autobiography_class_codes.instructor_name IS '강사 이름';
COMMENT ON COLUMN autobiography_class_codes.max_students    IS '동시 수강 가능 인원';
COMMENT ON COLUMN autobiography_class_codes.schedule        IS '예: "매주 화요일 오후 2시"';
COMMENT ON COLUMN autobiography_class_codes.active          IS 'FALSE면 신규 가입 차단 (기존 학생은 계속 진행 가능)';

CREATE INDEX IF NOT EXISTS idx_autobio_class_codes_active ON autobiography_class_codes (active) WHERE active = TRUE;

-- ============================================================
-- 검증 쿼리 (적용 후 실행해서 확인 — 주석 해제 후 사용)
-- ============================================================
--
-- 1) 모든 테이블·컬럼 존재 확인
-- SELECT table_name, column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name LIKE 'autobiography_%'
-- ORDER BY table_name, ordinal_position;
--
-- 2) FK 제약 확인
-- SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
-- FROM information_schema.table_constraints tc
-- JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
-- JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
-- WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name LIKE 'autobiography_%';
--
-- 3) 인덱스 확인
-- SELECT tablename, indexname, indexdef FROM pg_indexes
-- WHERE tablename LIKE 'autobiography_%' ORDER BY tablename, indexname;
--
-- 4) 시드: 강사 코드 1개 (테스트용)
-- INSERT INTO autobiography_class_codes (code, instructor_name, max_students, schedule)
-- VALUES ('TEST2026', '테스트 강사', 5, '매주 화요일 오후 2시')
-- ON CONFLICT (code) DO NOTHING;
