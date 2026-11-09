// =====================================================================
// 오프닝 법정 AI 점수 배치  (C++17, 외부 라이브러리 없음)
//
//   데이터: Lichess 오프닝 탐색기 (curl 로 호출, 개인 API 토큰 필요)
//   엔진  : Stockfish (UCI, 자식 프로세스로 실행)
//   출력  : ai_scores.sql (Supabase SQL Editor에 붙여 넣기), ai_scores.js (데모 모드용), ai_report.tsv
//
// 계획서 "AI 제안 티어 공식" 0~9번 식을 그대로 구현한다. 모든 값은 오프닝을 고른 쪽 σ 관점.
//   x_P  실전 성과    : 표본 보정 기대점수의 엘로 초과분 (+ 델타 방법 SE 상한)
//   x_Q  엔진 건전성  : P(c(x_o)) - P(c_0)
//   x_T  함정력      : 깊이 H 재귀 기대 헌납 승률
//   x_A  공격성      : 결정국 비율 로짓 초과분
//   x_R  안정성      : 도달확률 가중 "최선수 놓쳤을 때 평균 손해"의 음수
//   x_F  초보 친화도  : -(정의 수순 중 σ 수 + 외워야 할 수의 기댓값)
//   z = (x - median) / (1.4826 MAD),  S = 100 Φ(z),  종합 = Σ w z 재표준화
// =====================================================================
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#define POPEN _popen
#define PCLOSE _pclose
#else
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
#define POPEN popen
#define PCLOSE pclose
#endif

namespace fs = std::filesystem;
using std::string;
using std::vector;

// ------------------------------------------------------------------ 설정
struct Config {
    string stockfish;                  // 필수
    string token;                      // Lichess 개인 API 토큰 (없으면 환경변수 LICHESS_TOKEN)
    string openings = "openings.tsv";
    string outDir = "out";
    string cacheDir = "cache";
    string curl = "curl";
    string speeds = "blitz,rapid,classical";
    int depth = 18, threads = 2, hashMb = 256;
    int H = 3;                         // 함정 탐색 깊이 (상대 수 기준)
    int maxReplies = 5;                // 노드당 따라갈 상대 응수 최대 개수
    double gamma = 0.8;                // 깊이 감쇠
    double delta = 0.10;               // "외워야 하는 수" 기준 승률 차이
    double k = 50.0;                   // 베이지안 보정 강도 (판)
    double pmin = 0.02;                // 이 빈도 미만 응수는 잘라냄
    int delayMs = 1100;                // 탐색기 호출 간격 (초당 1회 이하)
    int limit = 0;                     // 0 = 전부 (테스트용으로 앞 N개만)
};

// 레이팅 구간 b 와 가중치 π_b (학교 친구 수준에 맞춰 낮은 구간을 크게)
struct Band { const char* ratings; const char* label; double pi; };
static const Band BANDS[4] = {
    {"1000,1200", "1000-1400", 0.35},
    {"1400,1600", "1400-1800", 0.35},
    {"1800,2000", "1800-2200", 0.20},
    {"2200,2500", "2200+", 0.10},
};

// 분야 id 와 종합 가중치 (02_seed.sql 의 categories 와 같아야 함, mental 은 AI 미산출)
struct CatDef { const char* id; double w; };
static const CatDef CATS[6] = {
    {"perf", 0.30}, {"engine", 0.25}, {"trap", 0.15}, {"stability", 0.10}, {"beginner", 0.10}, {"attack", 0.10}};

static const double LOGISTIC_A = 0.00368208;   // Lichess 센티폰→승률 계수
static const int MATE_CP = 10000;

static double P(double cp) { return 1.0 / (1.0 + std::exp(-LOGISTIC_A * cp)); }
static double logit(double p) { p = std::min(1 - 1e-9, std::max(1e-9, p)); return std::log(p / (1 - p)); }
static double elo(double e) { e = std::min(1 - 1e-9, std::max(1e-9, e)); return 400.0 * std::log10(e / (1 - e)); }
static double Phi(double z) { return 0.5 * std::erfc(-z / std::sqrt(2.0)); }

// ------------------------------------------------------------------ 아주 작은 JSON 파서 (탐색기 응답용)
struct Json {
    enum T { Null, Bool, Num, Str, Arr, Obj } t = Null;
    bool b = false; double n = 0; string s;
    vector<Json> a; vector<std::pair<string, Json>> o;
    const Json* get(const string& k) const { for (auto& kv : o) if (kv.first == k) return &kv.second; return nullptr; }
    double num(const string& k, double def = 0) const { auto p = get(k); return p && p->t == Num ? p->n : def; }
    string str(const string& k) const { auto p = get(k); return p && p->t == Str ? p->s : string(); }
};
class JsonParser {
    const string& s; size_t i = 0;
    void ws() { while (i < s.size() && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) ++i; }
    [[noreturn]] void fail(const char* m) { throw std::runtime_error(string("JSON 오류: ") + m + " @" + std::to_string(i)); }
    static void utf8(string& out, unsigned cp) {
        if (cp < 0x80) out += char(cp);
        else if (cp < 0x800) { out += char(0xC0 | (cp >> 6)); out += char(0x80 | (cp & 0x3F)); }
        else if (cp < 0x10000) { out += char(0xE0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
        else { out += char(0xF0 | (cp >> 18)); out += char(0x80 | ((cp >> 12) & 0x3F)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
    }
    unsigned hex4() {
        if (i + 4 > s.size()) fail("\\u");
        unsigned v = 0;
        for (int k = 0; k < 4; ++k) { char c = s[i++]; v <<= 4; if (c >= '0' && c <= '9') v |= c - '0'; else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10; else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10; else fail("hex"); }
        return v;
    }
    string str() {
        if (s[i] != '"') fail("문자열");
        ++i;
        string out;
        while (i < s.size() && s[i] != '"') {
            char c = s[i++];
            if (c != '\\') { out += c; continue; }
            if (i >= s.size()) fail("escape");
            char e = s[i++];
            switch (e) {
                case 'n': out += '\n'; break; case 't': out += '\t'; break; case 'r': out += '\r'; break;
                case 'b': out += '\b'; break; case 'f': out += '\f'; break;
                case 'u': { unsigned cp = hex4(); if (cp >= 0xD800 && cp < 0xDC00 && i + 1 < s.size() && s[i] == '\\' && s[i + 1] == 'u') { i += 2; unsigned lo = hex4(); cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); } utf8(out, cp); break; }
                default: out += e;
            }
        }
        if (i >= s.size()) fail("문자열 끝");
        ++i;
        return out;
    }
    Json val() {
        ws(); if (i >= s.size()) fail("끝"); Json j; char c = s[i];
        if (c == '{') {
            j.t = Json::Obj; ++i; ws();
            if (s[i] == '}') { ++i; return j; }
            for (;;) { ws(); string k = str(); ws(); if (s[i] != ':') fail(":"); ++i; j.o.emplace_back(k, val()); ws(); if (s[i] == ',') { ++i; continue; } if (s[i] == '}') { ++i; break; } fail("}"); }
        } else if (c == '[') {
            j.t = Json::Arr; ++i; ws();
            if (s[i] == ']') { ++i; return j; }
            for (;;) { j.a.push_back(val()); ws(); if (s[i] == ',') { ++i; continue; } if (s[i] == ']') { ++i; break; } fail("]"); }
        } else if (c == '"') { j.t = Json::Str; j.s = str(); }
        else if (s.compare(i, 4, "true") == 0) { j.t = Json::Bool; j.b = true; i += 4; }
        else if (s.compare(i, 5, "false") == 0) { j.t = Json::Bool; i += 5; }
        else if (s.compare(i, 4, "null") == 0) { i += 4; }
        else { size_t st = i; while (i < s.size() && (isdigit((unsigned char)s[i]) || s[i] == '-' || s[i] == '+' || s[i] == '.' || s[i] == 'e' || s[i] == 'E')) ++i; if (st == i) fail("값"); j.t = Json::Num; j.n = std::strtod(s.substr(st, i - st).c_str(), nullptr); }
        return j;
    }
public:
    explicit JsonParser(const string& src) : s(src) {}
    Json parse() { Json j = val(); ws(); return j; }
};

// ------------------------------------------------------------------ 유틸
static uint64_t fnv1a(const string& s) { uint64_t h = 1469598103934665603ULL; for (unsigned char c : s) { h ^= c; h *= 1099511628211ULL; } return h; }
static string hex64(uint64_t v) { std::ostringstream o; o << std::hex << std::setw(16) << std::setfill('0') << v; return o.str(); }
static string join(const vector<string>& v, const string& sep) { string r; for (size_t i = 0; i < v.size(); ++i) { if (i) r += sep; r += v[i]; } return r; }
static vector<string> split(const string& s, char d) { vector<string> r; string cur; std::istringstream is(s); while (std::getline(is, cur, d)) if (!cur.empty()) r.push_back(cur); return r; }
static string readFile(const fs::path& p) { std::ifstream f(p, std::ios::binary); std::ostringstream o; o << f.rdbuf(); return o.str(); }
static void sleepMs(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }
static string nowIso() { std::time_t t = std::time(nullptr); char b[32]; std::strftime(b, sizeof b, "%Y-%m-%dT%H:%M:%SZ", std::gmtime(&t)); return b; }

// ------------------------------------------------------------------ Lichess 탐색기 (curl 자식 프로세스 + 디스크 캐시)
struct Stats { double w = 0, d = 0, l = 0; double N() const { return w + d + l; } };   // 백 기준 승/무/패
struct ExplorerMove { string uci, san; Stats s; };
struct ExplorerNode { Stats s; vector<ExplorerMove> moves; };

class Explorer {
    const Config& cfg;
    fs::path dir;
    std::chrono::steady_clock::time_point last{};
    long netCalls = 0, cacheHits = 0;

    string httpGet(const string& url) {
        string auth = cfg.token.empty() ? "" : " -H \"Authorization: Bearer " + cfg.token + "\"";
        string cmd = "\"" + cfg.curl + "\" -sS --max-time 40" + auth + " -H \"Accept: application/json\" -w \"\\n%{http_code}\" \"" + url + "\"";
#ifdef _WIN32
        cmd = "\"" + cmd + "\"";   // cmd.exe /c 가 바깥 따옴표를 벗겨내므로 한 겹 더 감싼다
#endif
        for (int attempt = 0; attempt < 6; ++attempt) {
            auto wait = std::chrono::milliseconds(cfg.delayMs) - (std::chrono::steady_clock::now() - last);
            if (wait.count() > 0) std::this_thread::sleep_for(wait);
            last = std::chrono::steady_clock::now();
            ++netCalls;
            FILE* pipe = POPEN(cmd.c_str(), "r");
            if (!pipe) throw std::runtime_error("curl 을 실행하지 못했습니다. --curl 로 경로를 지정하세요.");
            string out; char buf[8192]; size_t n;
            while ((n = fread(buf, 1, sizeof buf, pipe)) > 0) out.append(buf, n);
            PCLOSE(pipe);
            while (!out.empty() && (out.back() == '\n' || out.back() == '\r')) out.pop_back();
            size_t nl = out.find_last_of('\n');
            string code = nl == string::npos ? out : out.substr(nl + 1);
            string body = nl == string::npos ? "" : out.substr(0, nl);
            if (code == "200") return body;
            if (code == "401" || code == "403")
                throw std::runtime_error("Lichess 가 요청을 거부했습니다 (HTTP " + code + "). --token 에 개인 API 토큰을 넣었는지 확인하세요.");
            int backoff = code == "429" ? 61000 : 3000 * (attempt + 1);
            std::cerr << "  탐색기 응답 HTTP " << (code.empty() ? "?" : code) << ", " << backoff / 1000 << "초 후 재시도\n";
            sleepMs(backoff);
        }
        throw std::runtime_error("탐색기 요청이 계속 실패합니다: " + url);
    }

public:
    explicit Explorer(const Config& c) : cfg(c), dir(fs::path(c.cacheDir) / "explorer") { fs::create_directories(dir); }
    long net() const { return netCalls; }
    long hits() const { return cacheHits; }

    ExplorerNode query(const vector<string>& moves, int band) {
        string url = "https://explorer.lichess.ovh/lichess?variant=standard&speeds=" + cfg.speeds +
                     "&ratings=" + BANDS[band].ratings + "&moves=12&topGames=0&recentGames=0";
        if (!moves.empty()) url += "&play=" + join(moves, ",");
        fs::path f = dir / (hex64(fnv1a(url)) + ".json");
        string body;
        if (fs::exists(f)) { body = readFile(f); ++cacheHits; }
        else {
            body = httpGet(url);
            JsonParser(body).parse();             // 깨진 응답은 캐시하지 않음
            std::ofstream(f, std::ios::binary) << body;
        }
        Json j = JsonParser(body).parse();
        ExplorerNode node;
        node.s = {j.num("white"), j.num("draws"), j.num("black")};
        if (auto mv = j.get("moves"))
            for (auto& m : mv->a) {
                ExplorerMove e; e.uci = m.str("uci"); e.san = m.str("san");
                // Lichess 는 캐슬링을 킹→룩 칸(e1h1)으로 줄 때가 있어 표준 UCI(e1g1)로 맞춘다
                if (e.san.rfind("O-O-O", 0) == 0) e.uci = e.uci.substr(0, 2) + (e.uci[1] == '1' ? "c1" : "c8");
                else if (e.san.rfind("O-O", 0) == 0) e.uci = e.uci.substr(0, 2) + (e.uci[1] == '1' ? "g1" : "g8");
                e.s = {m.num("white"), m.num("draws"), m.num("black")};
                node.moves.push_back(e);
            }
        return node;
    }
};

// ------------------------------------------------------------------ Stockfish (UCI 자식 프로세스)
class Process {
#ifdef _WIN32
    HANDLE hW = nullptr, hR = nullptr; PROCESS_INFORMATION pi{};
#else
    int wfd = -1, rfd = -1; pid_t pid = -1;
#endif
    string buf;
public:
    void start(const string& path) {
#ifdef _WIN32
        SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
        HANDLE outR, outW, inR, inW;
        if (!CreatePipe(&outR, &outW, &sa, 0) || !CreatePipe(&inR, &inW, &sa, 0)) throw std::runtime_error("파이프 생성 실패");
        SetHandleInformation(outR, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(inW, HANDLE_FLAG_INHERIT, 0);
        STARTUPINFOA si{}; si.cb = sizeof(si); si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = inR; si.hStdOutput = outW; si.hStdError = outW;
        string cmd = "\"" + path + "\""; vector<char> c(cmd.begin(), cmd.end()); c.push_back(0);
        if (!CreateProcessA(nullptr, c.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi))
            throw std::runtime_error("Stockfish 를 실행하지 못했습니다: " + path);
        CloseHandle(inR); CloseHandle(outW); hW = inW; hR = outR;
#else
        int a[2], b[2];
        if (pipe(a) || pipe(b)) throw std::runtime_error("파이프 생성 실패");
        pid = fork();
        if (pid < 0) throw std::runtime_error("fork 실패");
        if (pid == 0) {
            dup2(a[0], 0); dup2(b[1], 1); dup2(b[1], 2);
            close(a[0]); close(a[1]); close(b[0]); close(b[1]);
            execl(path.c_str(), path.c_str(), (char*)nullptr);
            _exit(127);
        }
        close(a[0]); close(b[1]); wfd = a[1]; rfd = b[0];
        signal(SIGPIPE, SIG_IGN);
#endif
    }
    void send(const string& line) {
        string s = line + "\n";
#ifdef _WIN32
        DWORD n; if (!WriteFile(hW, s.data(), (DWORD)s.size(), &n, nullptr)) throw std::runtime_error("엔진에 쓰기 실패");
#else
        if (write(wfd, s.data(), s.size()) != (ssize_t)s.size()) throw std::runtime_error("엔진에 쓰기 실패 (경로가 맞나요?)");
#endif
    }
    bool readLine(string& line) {
        for (;;) {
            size_t p = buf.find('\n');
            if (p != string::npos) { line = buf.substr(0, p); if (!line.empty() && line.back() == '\r') line.pop_back(); buf.erase(0, p + 1); return true; }
            char tmp[4096];
#ifdef _WIN32
            DWORD n = 0; if (!ReadFile(hR, tmp, sizeof tmp, &n, nullptr) || n == 0) return false;
#else
            ssize_t n = read(rfd, tmp, sizeof tmp); if (n <= 0) return false;
#endif
            buf.append(tmp, (size_t)n);
        }
    }
    ~Process() {
#ifdef _WIN32
        if (hW) { try { send("quit"); } catch (...) {} CloseHandle(hW); }
        if (hR) CloseHandle(hR);
        if (pi.hProcess) { WaitForSingleObject(pi.hProcess, 2000); CloseHandle(pi.hProcess); CloseHandle(pi.hThread); }
#else
        if (wfd >= 0) { try { send("quit"); } catch (...) {} close(wfd); }
        if (rfd >= 0) close(rfd);
        if (pid > 0) waitpid(pid, nullptr, 0);
#endif
    }
};

struct EngineMove { string uci; int cp; };   // cp = 둘 차례인 쪽 관점
struct EngineResult { vector<EngineMove> top; int terminalCp = 0; };   // top 비면 둘 수가 없음 (메이트/스테일메이트)

class Engine {
    const Config& cfg; Process proc;
    std::unordered_map<string, EngineResult> cache;
    fs::path cacheFile; std::ofstream cacheOut;
    long searches = 0;
    static const int K = 3;    // MultiPV (안정성 식의 K)
    void waitFor(const string& token) { string l; while (proc.readLine(l)) if (l.rfind(token, 0) == 0) return; throw std::runtime_error("엔진이 응답하지 않습니다 (" + token + ")"); }
public:
    explicit Engine(const Config& c) : cfg(c) {
        cacheFile = fs::path(c.cacheDir) / ("engine_d" + std::to_string(c.depth) + ".tsv");
        if (fs::exists(cacheFile)) {
            std::ifstream in(cacheFile); string line;
            while (std::getline(in, line)) {
                auto f = split(line, '\t'); if (f.size() < 2) continue;
                EngineResult r; r.terminalCp = std::atoi(f[1].c_str());
                for (size_t i = 2; i + 1 < f.size(); i += 2) r.top.push_back({f[i], std::atoi(f[i + 1].c_str())});
                cache[f[0] == "-" ? "" : f[0]] = r;
            }
        }
        cacheOut.open(cacheFile, std::ios::app);
        proc.start(c.stockfish);
        proc.send("uci"); waitFor("uciok");
        proc.send("setoption name Threads value " + std::to_string(c.threads));
        proc.send("setoption name Hash value " + std::to_string(c.hashMb));
        proc.send("setoption name MultiPV value " + std::to_string(K));
        proc.send("isready"); waitFor("readyok");
    }
    long count() const { return searches; }
    const EngineResult& eval(const vector<string>& moves) {
        string k = join(moves, " ");
        auto it = cache.find(k);
        if (it != cache.end()) return it->second;
        ++searches;
        proc.send(moves.empty() ? "position startpos" : "position startpos moves " + k);
        proc.send("go depth " + std::to_string(cfg.depth));
        std::map<int, EngineMove> byPv; int lastDepth = -1; EngineResult r; bool sawMate0 = false; string line;
        while (proc.readLine(line)) {
            if (line.rfind("bestmove", 0) == 0) break;
            if (line.rfind("info", 0) != 0 || line.find(" score ") == string::npos) continue;
            if (line.find("lowerbound") != string::npos || line.find("upperbound") != string::npos) continue;
            std::istringstream is(line); string tok; int depth = -1, mpv = 1, cp = 0; bool has = false; string first;
            while (is >> tok) {
                if (tok == "depth") is >> depth;
                else if (tok == "multipv") is >> mpv;
                else if (tok == "score") { string kind; int v; is >> kind >> v; if (kind == "cp") cp = v; else { if (v == 0) sawMate0 = true; cp = v > 0 ? MATE_CP : -MATE_CP; } has = true; }
                else if (tok == "pv") { is >> first; break; }
            }
            if (!has) continue;
            if (first.empty()) { r.terminalCp = cp; continue; }      // 둘 수 없는 국면 (depth 0)
            if (depth > lastDepth && mpv == 1) { byPv.clear(); lastDepth = depth; }
            if (depth == lastDepth) byPv[mpv] = {first, cp};
        }
        for (auto& kv : byPv) r.top.push_back(kv.second);
        if (r.top.empty() && sawMate0) r.terminalCp = -MATE_CP;
        std::ostringstream o; o << (k.empty() ? "-" : k) << '\t' << r.terminalCp;
        for (auto& m : r.top) o << '\t' << m.uci << '\t' << m.cp;
        cacheOut << o.str() << '\n'; cacheOut.flush();
        return cache[k] = r;
    }
};

// ------------------------------------------------------------------ 오프닝과 결과
struct Opening { int id = 0; string slug; char side = 'w'; vector<string> uci; };
struct Raw { double perf = NAN, se = NAN, engine = NAN, trap = NAN, attack = NAN, stability = NAN, beginner = NAN; };

static vector<Opening> loadOpenings(const string& path) {
    std::ifstream in(path);
    if (!in) throw std::runtime_error("오프닝 파일을 열 수 없습니다: " + path);
    vector<Opening> v; string line;
    while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty() || line[0] == '#') continue;
        std::istringstream is(line); string id, slug, side, moves;
        std::getline(is, id, '\t'); std::getline(is, slug, '\t'); std::getline(is, side, '\t'); std::getline(is, moves);
        Opening o; o.id = std::atoi(id.c_str()); o.slug = slug; o.side = side.empty() ? 'w' : side[0];
        o.uci = split(moves, ' ');
        if (o.id <= 0 || o.uci.empty() || (o.side != 'w' && o.side != 'b')) throw std::runtime_error("오프닝 파일 형식 오류: " + line);
        v.push_back(o);
    }
    return v;
}

class Scorer {
    const Config& cfg; Explorer& ex; Engine& en;
    double mu[4][2]{}, dbar[4]{};   // [밴드][σ: 0=백,1=흑]
    double c0[2]{};                 // 시작 국면 평가 (σ 관점)
    struct Acc { double rsum = 0, rl = 0, crit = 0; };

    static bool whiteToMove(const vector<string>& m) { return m.size() % 2 == 0; }
    // σ 관점 점수: 백 기준 통계 s 를 σ 쪽으로
    static double scoreFor(const Stats& s, bool sigmaWhite) { return sigmaWhite ? s.w + s.d / 2 : s.l + s.d / 2; }

    // 노드에서 상대 응수 분포 p_i (밴드 혼합, 빈도 pmin 미만 제거, 상위 maxReplies, 재정규화)
    vector<std::pair<string, double>> replies(const vector<string>& moves) {
        std::map<string, double> p; double piSum = 0;
        for (int b = 0; b < 4; ++b) {
            ExplorerNode n = ex.query(moves, b);
            double N = n.s.N(); if (N <= 0) continue;
            piSum += BANDS[b].pi;
            for (auto& m : n.moves) p[m.uci] += BANDS[b].pi * m.s.N() / N;
        }
        vector<std::pair<string, double>> v;
        if (piSum <= 0) return v;
        for (auto& kv : p) if (kv.second / piSum >= cfg.pmin) v.push_back({kv.first, kv.second / piSum});
        std::sort(v.begin(), v.end(), [](auto& a, auto& b) { return a.second > b.second; });
        if ((int)v.size() > cfg.maxReplies) v.resize(cfg.maxReplies);
        double s = 0; for (auto& x : v) s += x.second;
        for (auto& x : v) x.second /= s;
        return v;
    }
    // σ 차례 국면 y 기록: 안정성 ℓ(y), 외워야 하는 수 여부
    void sigmaNode(const EngineResult& r, double reach, Acc& acc) {
        if (r.top.empty()) return;
        double p1 = P(r.top[0].cp), loss = 0; int k = 0;
        for (size_t i = 1; i < r.top.size(); ++i) { loss += p1 - P(r.top[i].cp); ++k; }
        double ell = k ? loss / k : 0.0;
        double gap = r.top.size() > 1 ? p1 - P(r.top[1].cp) : 0.0;
        acc.rsum += reach; acc.rl += reach * ell;
        if (gap > cfg.delta) acc.crit += reach;
    }
    // 상대 차례 노드 y 의 T(y)
    double oppNode(const vector<string>& moves, int depthLeft, double reach, Acc& acc) {
        const EngineResult& e = en.eval(moves);
        if (e.top.empty()) return 0.0;                         // 상대가 둘 수 없음 (게임 끝)
        double cstar = -e.top[0].cp;                           // 상대 최선 → σ 관점
        auto rep = replies(moves);
        if (rep.empty()) for (auto& m : e.top) rep.push_back({m.uci, 1.0 / e.top.size()});   // 통계 없음 → 엔진 상위 수 균등
        double T = 0;
        for (auto& [mv, p] : rep) {
            vector<string> child = moves; child.push_back(mv);
            const EngineResult f = en.eval(child);              // σ 차례 (복사: 재귀 중 캐시 재해시 대비)
            double c1 = f.top.empty() ? f.terminalCp : f.top[0].cp;
            double d = std::max(0.0, P(c1) - P(cstar));
            sigmaNode(f, reach * p, acc);
            double sub = 0;
            if (depthLeft > 1 && !f.top.empty()) { vector<string> nxt = child; nxt.push_back(f.top[0].uci); sub = oppNode(nxt, depthLeft - 1, reach * p, acc); }
            T += p * (d + cfg.gamma * sub);
        }
        return T;
    }

public:
    Scorer(const Config& c, Explorer& x, Engine& e) : cfg(c), ex(x), en(e) {
        for (int b = 0; b < 4; ++b) {
            ExplorerNode n = ex.query({}, b);
            double N = n.s.N();
            if (N <= 0) throw std::runtime_error("시작 국면 통계가 비어 있습니다 (밴드 " + string(BANDS[b].label) + ")");
            mu[b][0] = scoreFor(n.s, true) / N; mu[b][1] = scoreFor(n.s, false) / N;
            dbar[b] = (n.s.w + n.s.l) / N;
            std::cerr << "  기준선 " << BANDS[b].label << ": 백 " << std::fixed << std::setprecision(3) << mu[b][0] << ", 결정국 " << dbar[b] << "\n";
        }
        const EngineResult& s = en.eval({});
        c0[0] = s.top.empty() ? 0 : s.top[0].cp; c0[1] = -c0[0];
    }

    Raw score(const Opening& o) {
        Raw r; bool sw = o.side == 'w'; int si = sw ? 0 : 1;
        // 1, 4: 실전 성과·공격성 (x_o 의 밴드별 통계)
        double xp = 0, var = 0, xa = 0;
        for (int b = 0; b < 4; ++b) {
            ExplorerNode n = ex.query(o.uci, b);
            double N = n.s.N(), pi = BANDS[b].pi;
            double E = (scoreFor(n.s, sw) + cfg.k * mu[b][si]) / (N + cfg.k);
            xp += pi * (elo(E) - elo(mu[b][si]));
            var += pi * pi / (E * (1 - E) * (N + cfg.k + 1));
            double dh = (n.s.w + n.s.l + cfg.k * dbar[b]) / (N + cfg.k);
            xa += pi * (logit(dh) - logit(dbar[b]));
        }
        r.perf = xp; r.se = 400.0 / std::log(10.0) * std::sqrt(var); r.attack = xa;

        // 2, 3, 5, 6: 엔진 + 트리 탐색
        Acc acc; int nSigma = 0;
        for (size_t i = 0; i < o.uci.size(); ++i) if ((i % 2 == 0) == sw) ++nSigma;
        bool sigmaToMove = whiteToMove(o.uci) == sw;
        const EngineResult root = en.eval(o.uci);
        double cxo;
        if (sigmaToMove) {
            cxo = root.top.empty() ? root.terminalCp : root.top[0].cp;
            sigmaNode(root, 1.0, acc);
            vector<string> nxt = o.uci; if (!root.top.empty()) nxt.push_back(root.top[0].uci);
            r.trap = root.top.empty() ? 0.0 : oppNode(nxt, cfg.H, 1.0, acc);
        } else {
            cxo = root.top.empty() ? -root.terminalCp : -root.top[0].cp;
            r.trap = oppNode(o.uci, cfg.H, 1.0, acc);
        }
        r.engine = P(cxo) - P(c0[si]);
        r.stability = acc.rsum > 0 ? -(acc.rl / acc.rsum) : NAN;
        r.beginner = -(nSigma + acc.crit);
        return r;
    }
};

// ------------------------------------------------------------------ 표준화와 출력
static double median(vector<double> v) { std::sort(v.begin(), v.end()); size_t n = v.size(); return n % 2 ? v[n / 2] : (v[n / 2 - 1] + v[n / 2]) / 2; }
// 결측(NaN)은 z = 0 (중앙값 취급)
static vector<double> robustZ(const vector<double>& x) {
    vector<double> ok; for (double v : x) if (std::isfinite(v)) ok.push_back(v);
    vector<double> z(x.size(), 0.0);
    if (ok.size() < 2) return z;
    double m = median(ok); vector<double> dev; for (double v : ok) dev.push_back(std::fabs(v - m));
    double s = 1.4826 * median(dev);
    if (s <= 1e-12) { double mean = 0, sq = 0; for (double v : ok) mean += v; mean /= ok.size(); for (double v : ok) sq += (v - mean) * (v - mean); s = std::sqrt(sq / (ok.size() - 1)); }
    if (s <= 1e-12) return z;
    for (size_t i = 0; i < x.size(); ++i) z[i] = std::isfinite(x[i]) ? (x[i] - m) / s : 0.0;
    return z;
}

static void usage() {
    std::cerr <<
        "사용법: oc_batch --stockfish <stockfish 경로> --token <Lichess 토큰> [옵션]\n"
        "  --openings openings.tsv   오프닝 목록 (기본: openings.tsv)\n"
        "  --out out                 결과 폴더 (ai_scores.sql, ai_scores.js, ai_report.tsv)\n"
        "  --cache cache             캐시 폴더 (다시 돌리면 이어서 계산)\n"
        "  --depth 18 --threads 2 --hash 256   엔진 설정\n"
        "  --H 3 --replies 5 --gamma 0.8 --delta 0.10 --k 50 --pmin 0.02   공식 상수\n"
        "  --delay 1100              탐색기 호출 간격(ms)\n"
        "  --curl curl               curl 실행 파일 경로\n"
        "  --limit N                 앞의 N개만 (테스트용)\n";
}

int main(int argc, char** argv) {
#ifdef _WIN32
    SetConsoleOutputCP(CP_UTF8);
#endif
    Config cfg;
    if (const char* t = std::getenv("LICHESS_TOKEN")) cfg.token = t;
    for (int i = 1; i < argc; ++i) {
        string a = argv[i];
        auto next = [&]() -> string { if (i + 1 >= argc) { usage(); std::exit(2); } return argv[++i]; };
        if (a == "--stockfish") cfg.stockfish = next();
        else if (a == "--token") cfg.token = next();
        else if (a == "--openings") cfg.openings = next();
        else if (a == "--out") cfg.outDir = next();
        else if (a == "--cache") cfg.cacheDir = next();
        else if (a == "--curl") cfg.curl = next();
        else if (a == "--speeds") cfg.speeds = next();
        else if (a == "--depth") cfg.depth = std::stoi(next());
        else if (a == "--threads") cfg.threads = std::stoi(next());
        else if (a == "--hash") cfg.hashMb = std::stoi(next());
        else if (a == "--H") cfg.H = std::stoi(next());
        else if (a == "--replies") cfg.maxReplies = std::stoi(next());
        else if (a == "--gamma") cfg.gamma = std::stod(next());
        else if (a == "--delta") cfg.delta = std::stod(next());
        else if (a == "--k") cfg.k = std::stod(next());
        else if (a == "--pmin") cfg.pmin = std::stod(next());
        else if (a == "--delay") cfg.delayMs = std::stoi(next());
        else if (a == "--limit") cfg.limit = std::stoi(next());
        else if (a == "-h" || a == "--help") { usage(); return 0; }
        else { std::cerr << "알 수 없는 옵션: " << a << "\n"; usage(); return 2; }
    }
    if (cfg.stockfish.empty()) { usage(); return 2; }
    if (cfg.token.empty()) std::cerr << "경고: Lichess 토큰이 없습니다. 2026년부터 탐색기는 토큰 없는 요청을 거부할 수 있어요.\n";

    try {
        fs::create_directories(cfg.outDir); fs::create_directories(cfg.cacheDir);
        vector<Opening> ops = loadOpenings(cfg.openings);
        if (cfg.limit > 0 && (int)ops.size() > cfg.limit) ops.resize(cfg.limit);
        std::cerr << "오프닝 " << ops.size() << "개, 깊이 " << cfg.depth << ", H=" << cfg.H << "\n";

        Explorer ex(cfg); Engine en(cfg);
        Scorer sc(cfg, ex, en);
        vector<Raw> raws;
        auto t0 = std::chrono::steady_clock::now();
        for (size_t i = 0; i < ops.size(); ++i) {
            Raw r = sc.score(ops[i]);
            raws.push_back(r);
            double el = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
            std::cerr << "[" << i + 1 << "/" << ops.size() << "] " << std::left << std::setw(22) << ops[i].slug << std::right << std::fixed << std::setprecision(3)
                      << " P " << std::setw(7) << r.perf << " Q " << std::setw(6) << r.engine << " T " << std::setw(6) << r.trap
                      << " R " << std::setw(6) << r.stability << " F " << std::setw(6) << r.beginner << " A " << std::setw(6) << r.attack
                      << "  (탐색기 " << ex.net() << "회, 엔진 " << en.count() << "회, " << (int)el << "초)\n";
        }

        // 분야별 z → S
        auto col = [&](double Raw::*m) { vector<double> v; for (auto& r : raws) v.push_back(r.*m); return v; };
        std::map<string, vector<double>> rawCol = {
            {"perf", col(&Raw::perf)}, {"engine", col(&Raw::engine)}, {"trap", col(&Raw::trap)},
            {"attack", col(&Raw::attack)}, {"stability", col(&Raw::stability)}, {"beginner", col(&Raw::beginner)}};
        std::map<string, vector<double>> z;
        for (auto& kv : rawCol) z[kv.first] = robustZ(kv.second);
        vector<double> y(ops.size(), 0.0);
        for (auto& c : CATS) for (size_t i = 0; i < ops.size(); ++i) y[i] += c.w * z[c.id][i];
        vector<double> zo = robustZ(y);

        string stamp = nowIso();
        std::ofstream sql(fs::path(cfg.outDir) / "ai_scores.sql"), js(fs::path(cfg.outDir) / "ai_scores.js"), rep(fs::path(cfg.outDir) / "ai_report.tsv");
        sql << std::setprecision(10) << "-- 오프닝 법정 AI 점수 (" << stamp << ", 깊이 " << cfg.depth << ")\n-- Supabase SQL Editor 에 붙여 넣고 Run\nbegin;\n"
            << "insert into public.ai_scores (opening_id, category_id, raw, z, score, se, computed_at) values\n";
        js << std::setprecision(6) << "// 오프닝 법정 AI 점수 (" << stamp << ") — 데모 모드용\nwindow.OC_AI = [\n";
        rep << std::setprecision(6) << "id\tslug\traw_perf\tse_perf\traw_engine\traw_trap\traw_attack\traw_stability\traw_beginner\tS_perf\tS_engine\tS_trap\tS_attack\tS_stability\tS_beginner\tS_overall\n";
        bool first = true;
        auto emit = [&](int id, const string& cat, double raw, double zz, double se) {
            double s = std::min(100.0, std::max(0.0, 100.0 * Phi(zz)));
            auto num = [](double v) { if (!std::isfinite(v)) return string("null"); std::ostringstream o; o << std::setprecision(10) << v; return o.str(); };
            sql << (first ? "  " : ",\n  ") << "(" << id << ", '" << cat << "', " << num(raw) << ", " << num(zz) << ", " << num(s) << ", " << num(se) << ", '" << stamp << "')";
            js << (first ? "  " : ",\n  ") << "{\"opening_id\":" << id << ",\"category_id\":\"" << cat << "\",\"score\":" << num(s) << ",\"se\":" << num(se) << "}";
            first = false;
            return s;
        };
        // 실전 성과 SE(엘로) → 점수 단위: S = 100 Φ(z), z = (x - m)/scale 이므로 dS = 100 φ(z) dx / scale
        double perfScale = 0;
        {
            vector<double> ok; for (double v : rawCol["perf"]) if (std::isfinite(v)) ok.push_back(v);
            if (ok.size() >= 2) { double m = median(ok); vector<double> dev; for (double v : ok) dev.push_back(std::fabs(v - m)); perfScale = 1.4826 * median(dev); }
        }
        const double PI = 3.14159265358979323846;
        for (size_t i = 0; i < ops.size(); ++i) {
            int id = ops[i].id; const Raw& r = raws[i];
            vector<double> svals;
            for (const char* c : {"perf", "engine", "trap", "attack", "stability", "beginner"}) {
                double seScore = NAN;
                if (string(c) == "perf" && std::isfinite(r.se) && perfScale > 1e-12) {
                    double zp = z["perf"][i];
                    seScore = 100.0 * std::exp(-zp * zp / 2) / std::sqrt(2 * PI) * r.se / perfScale;
                }
                svals.push_back(emit(id, c, rawCol[c][i], z[c][i], seScore));
            }
            double so = emit(id, "overall", y[i], zo[i], NAN);
            rep << id << '\t' << ops[i].slug << '\t' << r.perf << '\t' << r.se << '\t' << r.engine << '\t' << r.trap << '\t' << r.attack << '\t' << r.stability << '\t' << r.beginner;
            for (double v : svals) rep << '\t' << v;
            rep << '\t' << so << '\n';
        }
        sql << "\non conflict (opening_id, category_id) do update set raw = excluded.raw, z = excluded.z, score = excluded.score, se = excluded.se, computed_at = excluded.computed_at;\ncommit;\n";
        js << "\n];\n";
        std::cerr << "완료. 결과: " << (fs::path(cfg.outDir) / "ai_scores.sql").string() << "\n";
    } catch (const std::exception& e) {
        std::cerr << "오류: " << e.what() << "\n";
        return 1;
    }
    return 0;
}
