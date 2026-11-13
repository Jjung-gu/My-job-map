# Project: 내일의 지도 (My-job-map)
수도권 거점별 기업 DB & 역대 채용 공고 아카이브 웹 애플리케이션

## Tech Stack
- **Frontend**: Vanilla HTML5, JavaScript (ES6+), Tailwind CSS (CDN), Font Awesome 6
- **Map Graphics**: Custom Inline SVG (Jigsaw Puzzle style interlocking geometry)
- **Backend / Hosting**: Cloudflare Pages + Cloudflare Pages Functions (`/api/jobs`)
- **Database**: Cloudflare D1 (SQLite) + `localStorage` fallback & caching (`my_jobs_data`, `my_company_tags`)

## Core Architecture & Region Rules
- 단일 `index.html` 기반 SPA 구조 유지 (별도 빌드 도구 없음).
- **수도권 10대 핵심 권역 명칭 (수정 금지)**:
  1. `인천광역시`
  2. `서울 서남부권` (구 명칭 `서울 서남 1구역` 자동 정규화 유지)
  3. `서울 남부권` (구 명칭 `서울 서남 2구역` 자동 정규화 유지)
  4. `서울 강북권`
  5. `서울 강남권`
  6. `경기 남부 1구역` (부천·시흥·광명)
  7. `경기 남부 2구역` (안양·과천·군포·의왕)
  8. `경기 남부 3구역` (성남·용인·하남)
  9. `수원시`
  10. `화성시(동탄)`

## UI & Sorting Conventions
- **카드 테두리/배경 시각 규칙**:
  - 마감 공고 (`isExpired`): 진한 검정 테두리 (`border-2 border-slate-900`)
  - 상시/채용시 마감 (`채용시마감`): 채도 낮은 주황 배경 (`bg-orange-50/50`) + 주황 테두리 + `D-∞` 배지
  - 마감 임박 (D-3 이하): 채도 낮은 빨강 배경 (`bg-rose-50/60`) + 빨강 테두리
- **정렬 기준**:
  - `현재 채용 중인 공고` 탭: 상시 채용(`D-∞`) 최우선 배치 → 이후 마감 임박순(남은 일수 오름차순)
  - `역대 전체 아카이브` 탭: 회사명 기준 한글 가나다순 / 영문 A-Z순 (`localeCompare('ko')`)
- **토글 인터랙션**: 지도 구역 및 기업 풀 칩을 1회 클릭 시 필터 적용, 동일 항목 2회 클릭 시 전체 복귀.

## DO NOT (절대 금지 사항)
- **데이터 유실 방지**: `/api/jobs` 응답이 빈 배열(`[]`)이거나 에러일 때, 기존 `localStorage`에 데이터가 존재한다면 절대 빈 배열로 덮어쓰지 말 것.
- **SVG 무결성**: `<path d="...">` 수정 시 줄바꿈이나 닫히지 않은 따옴표로 인해 하단 DOM 및 `<script>` 파싱이 깨지지 않도록 반드시 유효성을 검증할 것.
- **코어 기능 임의 삭제 금지**: D1 동기화 배지(`#sync-status-badge`), JSON 백업/불러오기, 기업 풀 상태 태그(`✔`, `✖`, `■`), 수정 모달 내 `[공고 마감 처리]` 버튼을 임의로 제거하지 말 것.
- **코드 제공 방식**: 부분 생략 없이 복사·붙여넣기 가능한 완전한 전체 코드를 제공할 것.
