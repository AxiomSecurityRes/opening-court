// C++ 배치(batch/)를 실행하면 이 파일이 실제 AI 점수로 덮어써집니다.
// Supabase 모드에서는 쓰이지 않고(DB의 ai_scores 테이블을 씀), 데모 모드에서만 쓰입니다.
// null 이면 데모 모드는 "데모용 임의 점수"를 만들어 화면을 채웁니다.
window.OC_AI = null;
