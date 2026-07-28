# senbi-auto

네이버 블로그 **자동 포스팅·발행·이웃관리** 데스크톱 앱. senbiPost의 Claude 생성·검증 파이프라인을 이식하고, 그 위에 Playwright 브라우저 자동화(발행·이웃)를 얹었다. 맥·윈도우 공용. **Electron 앱**(더블클릭 실행 + 트레이 상주)이며, 내부 엔진은 브라우저 없이 백그라운드에서 도는 Node 데몬이다 — 대시보드는 설정·모니터링용 조종석일 뿐.

## 무엇을 하나

1. **학습·생성** — 설정한 블로그의 최근 글 ~20개를 크롤링해 문체를 학습하고, 주제 키워드로 새 글을 생성한다. (상업어·비속어·필터 검증, 분량 보정, 모바일 줄바꿈, 센비·GEO 스코어까지 senbiPost와 동일)
2. **이미지** — 크롤한 글의 이미지를 가져와 **약한 필터**(밝기·채도·색상 미세 보정 + 가장자리 크롭 + 재인코딩)를 씌워 삽입한다. 부족하면 내 이미지 폴더(`~/.senbi-auto/my-images`)에서 보충.
3. **발행** — 로그인 세션으로 SmartEditor에 글을 채워 발행(또는 임시저장).
4. **이웃관리** — 이웃 새글에 공감 + 맥락형 AI 댓글(랜덤 지연·일일 한도·중복 방지), 주제 키워드로 블로그를 찾아 서로이웃 신청(AI 문구).

## 구조

```
src/
  config/   paths·store(JSON)·settings          설정/영속
  core/     types·text·score·geoScore·activity·drafts·logger
  crawl/    rss·post·crawler                    RSS + 본문·이미지 스크레이프  ✅검증
  media/    images                              다운로드 + sharp 약한 필터   ✅검증
  generate/ pipeline·index·social               Claude 생성/검증 + 댓글·서로이웃 문구
  naver/    session·publish·neighbor            Playwright 세션·발행·이웃      ⚠️튜닝
  run/      postJob·neighborJob                 오케스트레이션
  scheduler.ts                                  node-cron 예약·수동 실행
  server/   dashboard·public/index.html         Fastify + 로컬 대시보드      ✅검증
  index.ts                                      데몬 진입점
  scripts/  crawl-test·gen-test·img-test·login·browser-check
electron/   main.cjs·tray.png                    Electron 껍데기(창+트레이, 엔진을 자식 프로세스로 실행)
scripts/    make-icons·build-engine              아이콘 생성·패키징 번들
build/      icon.png                             앱 아이콘
```

## 설치 (맥)

```bash
cd senbi-auto
npm install
npm run setup:browser        # Playwright Chromium 설치 (1회)
cp .env.example .env         # ANTHROPIC_API_KEY 채우기
```

## 사용

### 데스크톱 앱으로 실행 (권장)

```bash
npm run app          # Electron 앱 창 + 트레이 상주로 실행
```

앱 아이콘 더블클릭과 동일한 경험 — 자체 창으로 대시보드가 뜨고, 창을 닫아도 **상단 메뉴바(트레이)에서 백그라운드로 계속 실행**된다. 종료는 트레이 메뉴 → 종료.

설치용 `.dmg`(맥) / `.exe`(윈도우)를 만들려면:

```bash
npm run app:build    # release/ 에 설치 파일 생성 (electron-builder)
```

### 자동 업데이트

설치본은 GitHub Releases를 보고 스스로 업데이트한다. 윈도우는 백그라운드 다운로드 후 재시작만 하면 되고(완전 자동), 맥은 새 버전 알림 후 dmg를 받아 교체한다. 배포 방법은 [RELEASE.md](RELEASE.md) 참고.

```bash
npm version patch && git push --follow-tags   # 태그 푸시 → CI가 빌드·릴리스 → 사용자 앱 자동 업데이트
```

### 헤드리스 데몬으로만 실행 (창 없이)

```bash
npm start            # http://localhost:3060
```

### 최초 1회 · 단독 테스트

```bash
npm run login                            # 네이버 로그인 세션 만들기 (창에서 직접 로그인)
npm run crawl -- <blogId> 5              # 크롤만
npm run gen   -- <blogId> "<메인키워드>" # 크롤 → 생성 (API 키 필요)
```

대시보드에서 대상 블로그·주제 키워드·스케줄·이미지 소스·이웃 한도를 설정하고, `자동 발행`을 켜면 cron 스케줄에 따라 자동 실행된다. 백그라운드 상주는 맥이 깨어 있어야 한다(수면 시 `caffeinate` 권장, 완전 무인 24시간은 상시 켜진 PC/서버 필요).

## 현재 상태

- ✅ **크롤·이미지 필터·생성 파이프라인·대시보드·스케줄러**: 구현·검증 완료
- ⚠️ **네이버 발행/이웃 DOM 셀렉터**(`naver/publish.ts`, `naver/neighbor.ts`): 구조 완성, **로그인 세션에서 셀렉터 1회 튜닝 필요**(SmartEditor·공감·댓글·서로이웃의 실제 DOM에 맞춤). 셀렉터는 각 파일 상단 `SEL`에 모여 있다.

## 안전·정책

- 프로그램은 **비밀번호를 대신 입력하지 않는다** — 첫 로그인만 사용자가 직접 하고 세션을 재사용한다.
- 자동 댓글·공감·대량 서로이웃은 네이버 운영정책상 **제재 위험**이 있다. 랜덤 지연·일일 한도·맥락형 댓글로 위험을 낮췄으나, 한도는 보수적으로 시작할 것. `autoPublish` 기본값은 꺼짐.
- 크롤 이미지 재사용은 저작권 이슈가 있을 수 있다 — 가능하면 내 이미지 폴더를 함께 쓰는 것을 권장.
