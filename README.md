# Mission Project

React + Vite + TypeScript 앱 (Supabase 연동)

## 1. 설치

```bash
cd c:\Users\전순용\Desktop\Golfworks\Mission_project
npm install
```

## 2. Supabase 설정

Supabase 프로젝트를 생성하고, 다음 테이블을 만든 뒤 URL/ANON KEY를 `.env`에 넣습니다.

### users 테이블
- id (uuid, 기본값: `gen_random_uuid()` 또는 `uuid_generate_v4()`)
- role (text, coach/player)
- coach_code (text)

### missions 테이블
- id (serial, primary key)
- title (text)
- description (text)
- category (text)
- subcategory (text)
- created_by (text)
- assigned_to (text) // 'all' 또는 player id

### mission_logs 테이블
- id (serial, primary key)
- mission_id (integer, foreign key -> missions.id)
- player_id (text, users.id)
- status (text, pending/completed)
- note (text)
- coach_feedback (text)
- created_at (timestamp with time zone, default now())

### .env
```
VITE_SUPABASE_URL=https://<your-project>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key>
# 또는 새 프로젝트에서는 publishable key 사용
VITE_SUPABASE_PUBLISHABLE_KEY=<your-publishable-key>
```

## 3. 실행

```bash
npm run dev
```

## 4. 사용자 시나리오

- 코치: 코치 코드로 로그인, 미션 작성
- 선수: 선수 ID로 로그인, 코치가 만든 미션 조회/완료 버튼

## 5. 확장 계획
- 미션 할당(선택 선수 / 전체)
- 미션 결과 기록 및 분석, 피드백
- 카테고리 세부 조건 추가
