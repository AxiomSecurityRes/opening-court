# 오프닝 법정

학교 친구들끼리 체스 오프닝 128개를 분야별로 투표해 티어를 매기고, 토론하는 웹사이트입니다.
AI 점수는 Lichess 대국 통계 + Stockfish 엔진으로 계산하고, 투표는 그 점수를 출발점 삼아 판결을 바꿉니다.

**사이트 주소: https://axiomsecurityres.github.io/opening-court/** (`main` 브랜치에 push 하면 GitHub Actions 가 `web/` 폴더를 자동 배포)

```
opening-court/
├─ web/                 ← 사이트 (이 폴더 하나만 호스팅하면 됨)
│  ├─ index.html, style.css, app.js
│  ├─ config.js         ← Supabase 주소/키 넣는 곳
│  └─ data/seed.js, data/ai_scores.js
├─ supabase/
│  ├─ 01_schema.sql     ← 테이블·권한·초대코드 (먼저 실행)
│  └─ 02_seed.sql       ← 분야 7개 + 오프닝 128개 (그다음 실행)
└─ batch/               ← AI 점수 계산기 (C++17, 외부 라이브러리 없음)
   ├─ src/main.cpp, CMakeLists.txt
   ├─ openings.tsv      ← 오프닝들의 UCI 수순 (수순 미입력 7개는 주석 처리)
   └─ run_windows.bat
```

---

## 1. 먼저 데모로 구경하기 (설치 0)

`web/index.html` 을 브라우저로 열면 됩니다. `config.js` 가 비어 있으면 **데모 모드**로 돌아가요.

- 데모 초대 코드: `DEMO`
- 저장은 그 브라우저에만 됩니다 (친구와 공유 안 됨)
- 처음엔 투표·글이 하나도 없는 빈 상태로 시작하고, 처음 가입한 사람이 관리자가 됩니다
- AI 칸은 C++ 배치를 돌리기 전까지 "데모용 임의 값"이라고 표시됩니다
- `나` 탭 → "데모 데이터 초기화"로 처음 상태로 돌릴 수 있어요

---

## 2. 친구들과 온라인으로 쓰기

### 2-1. Supabase (DB + 로그인, 무료)

1. https://supabase.com 에서 새 프로젝트를 만듭니다. 지역은 가까운 곳(Seoul/Tokyo)이 빠릅니다.
2. 왼쪽 **SQL Editor** → 새 쿼리 → `supabase/01_schema.sql` 전체를 붙여 넣고 **Run**.
3. 같은 방법으로 `supabase/02_seed.sql` 을 **Run**. (오프닝 128개가 들어갑니다)
4. **초대 코드 바꾸기**: 기본값은 `CHESS-2026` 입니다. 사이트에 처음 가입한 사람이 자동으로 관리자가 되니, 본인이 먼저 가입한 뒤 `나 → 관리자 도구`에서 바꾸면 됩니다.
5. **이메일 확인 끄기 (꼭 해야 함)**: Authentication 설정의 Email 로그인 항목에서 **Confirm email** 을 끕니다.
   이 사이트는 이메일 대신 닉네임으로 가입하고, 내부적으로 닉네임을 가짜 이메일(`u<해시>@opening-court.app`)로 바꿔 쓰기 때문에 확인 메일을 받을 수 없어요.
6. Project Settings → **API** 에서 `Project URL` 과 `anon public` 키를 복사합니다.

### 2-2. config.js 채우기

```js
window.OC_CONFIG = {
  SUPABASE_URL: "https://abcdefgh.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi...",
  ...
};
```

`anon` 키는 공개돼도 괜찮습니다 (누가 무엇을 읽고 쓸 수 있는지는 DB의 RLS 정책이 막아요).
**`service_role` 키는 절대 넣지 마세요.**

### 2-3. 호스팅 (무료, 셋 중 하나)

- **Netlify Drop**: 사이트에 `web` 폴더를 통째로 끌어다 놓으면 주소가 바로 나옵니다. 가장 쉬움.
- **GitHub Pages**: 저장소에 올리고 Pages 를 켜서 `web` 폴더를 배포.
- **Vercel**: 새 프로젝트 → 루트 디렉터리를 `web` 으로 지정.

빌드 과정이 없는 정적 파일이라 어디에 올려도 그대로 돌아갑니다. 주소를 친구들에게 초대 코드와 함께 보내면 끝.

---

## 3. AI 점수 계산 (C++ 배치)

AI 점수가 없으면 사이트의 "AI" 칸이 비고, 최종 점수는 중립값 50(= D)에서 투표로만 움직입니다.

### 준비물

1. **Stockfish**: https://stockfishchess.org/download/ 에서 받아 압축을 풉니다.
2. **Lichess 개인 API 토큰**: https://lichess.org/account/oauth/token 에서 만들기 (권한 체크 없이 생성).
   2026년부터 오프닝 탐색기는 토큰 없는 요청을 거부할 수 있습니다.
3. **curl**: Windows 10 이상, macOS, 리눅스에 기본으로 들어 있어요.

### 빌드

```bash
cd batch
cmake -B build
cmake --build build --config Release
```

CMake 없이 한 줄로:

```bash
g++ -std=c++17 -O2 -o oc_batch src/main.cpp                 # MinGW / macOS / 리눅스
cl /std:c++17 /O2 /EHsc /utf-8 src\main.cpp /Fe:oc_batch.exe   # Visual Studio 개발자 명령 프롬프트
```

### 실행

Windows: `run_windows.bat` 안의 `STOCKFISH` 경로와 `LICHESS_TOKEN` 두 줄을 고치고 더블클릭.

직접 실행:

```bash
./oc_batch --stockfish /경로/stockfish --token lip_xxxx --openings openings.tsv --out out --cache cache --depth 18 --threads 4
```

- 오프닝 하나당 탐색기 약 124번, 엔진 약 186번을 호출합니다. 탐색기는 초당 1회로 제한해서 **121개 전체에 4~6시간** 걸려요. 밤에 돌려 두세요.
- 중간에 꺼져도 `cache/` 에 받은 데이터가 남아서, 같은 명령을 다시 실행하면 이어서 계산합니다. 두 번째 실행부터는 몇 초.
- 먼저 `--limit 3 --depth 12` 로 짧게 돌려서 잘 되는지 확인해 보는 걸 추천합니다.

### 결과 넣기

- `out/ai_scores.sql` → Supabase SQL Editor 에 붙여 넣고 **Run**. 사이트를 새로고침하면 AI 티어가 나옵니다.
- `out/ai_scores.js` → `web/data/` 에 복사하면 데모 모드에서도 진짜 점수가 보입니다 (`run_windows.bat` 은 자동으로 복사).
- `out/ai_report.tsv` → 분야별 원점수와 0~100 점수. 엑셀로 열어서 공식이 이상하게 나온 곳을 찾을 때 씁니다.

### 공식 상수 바꾸기

| 옵션 | 기본값 | 뜻 |
| --- | --- | --- |
| `--k` | 50 | 판 수가 적을 때 평균 쪽으로 당기는 세기 |
| `--H` | 3 | 함정 탐색 깊이 (상대 수 기준) |
| `--gamma` | 0.8 | 깊은 함정일수록 덜 쳐주는 비율 |
| `--delta` | 0.10 | 1위 수와 2위 수 승률 차이가 이보다 크면 "외워야 하는 수" |
| `--pmin` | 0.02 | 이 빈도 미만의 상대 응수는 무시 |
| `--replies` | 5 | 한 국면에서 따라갈 상대 응수 수 |
| `--depth` | 18 | Stockfish 탐색 깊이 |

레이팅 구간 가중치(1000–1400: 0.35, 1400–1800: 0.35, 1800–2200: 0.20, 2200+: 0.10)와 종합 가중치는 `src/main.cpp` 위쪽 `BANDS`, `CATS` 에 있습니다. 종합 가중치를 바꾸면 `supabase/02_seed.sql` 의 categories `weight` 도 똑같이 바꿔 주세요.

---

### 수순이 비어 있는 오프닝 7개

아래 7개는 확실한 수순을 찾지 못해 비워 두었습니다. 관리자로 로그인해 오프닝 페이지의 **수순 편집**에서 넣으면 바로 체스판에 나오고, 화면에 나오는 "AI 배치용 줄"을 `batch/openings.tsv` 의 해당 주석 줄 자리에 붙여 넣으면 다음 배치 때 AI 점수도 계산됩니다.

The Wrongcloud 와 The Cow 는 chess.com 오프닝 페이지, 나머지 대부분은 Lichess 공식 오프닝 이름 목록(lichess-org/chess-openings)의 수순을 썼습니다.

| 번호 | 이름 |
| --- | --- |
| 75 | Dragadorf Variation |
| 98 | Ruy Lopez: Columbus Variation |
| 116 | Delayed Albin Countergambit |
| 123 | XQC Attack |
| 126 | Bongcloud: Advanced Variation |
| 127 | 지뢰살포 갬빗 (슥슥이) |
| 128 | 개잼 바리에이션 (슥슥이) |

`Englund Gambit: Rosen Trap` 은 에릭 로젠이 유명하게 만든 잉글룬드 함정(…Qc1#)으로 넣었습니다. 다른 수순이면 같은 방법으로 고치세요.

## 4. 점수 규칙 요약

**티어 11단계** (점수 0~100)

| 티어 | 설명 | 점수 |
| --- | --- | --- |
| 안 두면 직무유기 | 이걸 모르고 체스를 둔다고? | 97 이상 |
| SS | 그랜드마스터의 비밀 노트 | 92~97 |
| S | 레이팅 엘리베이터 | 85~92 |
| A | 대회 단골손님 | 75~85 |
| B | 교내 대회 우승각 | 65~75 |
| C | 동네 공원 체스 | 55~65 |
| D | 5수 두고 후회 | 45~55 |
| E | 상대가 속으로 환호 | 35~45 |
| F | 레이팅 자선 단체 | 25~35 |
| 기보 소각 대상 | 남은 기록까지 태워야 함 | 12~25 |
| 인류의 수치 | 외계인이 보면 지구 침공함 | 12 미만 |

**분야별 최종 점수**: 투표한 티어는 그 구간의 가운데 점수로 바꾸고, AI 점수를 5표 분량의 출발점으로 둔 베이지안 평균을 냅니다.

$$S^{\mathrm{final}} = \frac{5\,S^{\mathrm{AI}} + \sum_{m=1}^{n} v_m}{5 + n}$$

AI 점수가 없는 분야(멘탈 파괴력)는 출발점이 50입니다.

**종합 최종 점수**: AI 종합 점수를 출발점으로 두고, 분야 투표의 가중 평균을 가중 평균 투표 수만큼 반영합니다. 분야별 최종 점수를 단순 평균하면 점수가 가운데로 몰려 티어가 다 C~D가 되기 때문에 이렇게 합니다.

AI 원점수의 자세한 식(실전 성과·엔진 건전성·함정력·공격성·안정성·초보 친화도, 강건 표준화)은 계획서의 "AI 제안 티어 공식"과 `batch/src/main.cpp` 맨 위 주석에 있습니다.

---

## 5. 기능 목록

- 초대 코드 가입 / 닉네임 로그인 (첫 가입자 = 관리자)
- 종합 + 분야 7개 티어 사다리, 최종·투표·AI 보기 전환, 그룹(오프닝·디펜스, 시실리안, 변화·갬빗, 비공식) 필터, 검색
- 관리자 수순 편집: 오프닝 페이지에서 수순을 입력하면 규칙 검사 후 저장하고, AI 배치용 줄도 보여 줌
- 오프닝 페이지: 수순을 한 수씩 넘겨 보는 체스판, 분야별 AI·투표·최종 티어, 투표 분포, 11칸 투표 버튼(같은 칸 다시 누르면 취소)
- 토론 게시판: 자유 / 오프닝별 글, 댓글, 좋아요, 신고, 욕설 필터
- 오늘의 법정: 의견이 가장 갈린 사건(표준편차), AI vs 우리 반 차이, 참여율
- 관리자 도구: 초대 코드 변경, 신고 처리, 글·댓글 삭제, 관리자 지정, 차단

체스 기물 그림은 cburnett 세트(Colin M. L. Burnett, GPLv2+)를 `web/pieces.css` 에 SVG로 넣어 썼습니다.

## 6. 문제 해결

| 증상 | 원인 / 해결 |
| --- | --- |
| 가입 후 "바로 로그인되지 않았어요" | Supabase 에서 Confirm email 이 켜져 있음 → 끄기 |
| "초대 코드가 틀렸어요" | 관리자 도구에서 현재 코드 확인 (기본 `CHESS-2026`) |
| 로그인 후 티어가 비어 있음 | `02_seed.sql` 을 실행 안 함 |
| "서버에 연결하지 못했어요" | `config.js` 주소·키 오타, 또는 인터넷 |
| 배치가 HTTP 401 로 멈춤 | Lichess 토큰이 없거나 틀림 |
| 배치가 "Stockfish 를 실행하지 못했습니다" | `--stockfish` 경로에 실행 파일 이름까지 넣었는지 확인 |

Supabase 는 기본 설정(API의 Max rows)에서 한 번에 1000행까지 돌려줍니다. 지금 구조(오프닝 128 × 분야 7 = 896행)는 그 안에 들어가지만, 오프닝을 140개 넘게 늘리면 `app.js` 의 집계 조회를 나눠 받도록 바꿔야 합니다.
