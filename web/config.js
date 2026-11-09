// =====================================================================
// 오프닝 법정 설정 파일
// SUPABASE_URL 과 SUPABASE_ANON_KEY 를 비워 두면 "데모 모드"로 돌아갑니다.
// (데모 모드 = 이 기기 브라우저에만 저장, 친구와 공유 안 됨)
// Supabase 대시보드 → Project Settings → API 에서 두 값을 복사해 넣으세요.
// anon key 는 공개돼도 되는 키입니다 (권한은 DB의 RLS가 막음).
// service_role key 는 절대 여기에 넣지 마세요.
// =====================================================================
window.OC_CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",

  // 사이트 이름 (헤더와 탭 제목)
  SITE_NAME: "오프닝 법정",

  // AI 점수를 몇 표 분량의 사전값으로 볼지 (계획서의 C)
  PRIOR_STRENGTH: 5,

  // 닉네임을 내부 로그인용 이메일로 바꿀 때 쓰는 도메인 (실제 메일은 안 보냄, 바꾸지 마세요)
  EMAIL_DOMAIN: "opening-court.app"
};
