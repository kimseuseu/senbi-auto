# 배포 & 자동 업데이트 가이드

설치본은 **GitHub Releases**에 올라가고, 설치된 앱들이 그걸 보고 스스로 업데이트한다.

| 플랫폼 | 동작 |
| --- | --- |
| 윈도우 | 새 버전을 백그라운드로 내려받고 → "지금 재시작" 누르면 설치·재실행. 나중을 누르면 앱 종료 시 자동 설치. **완전 자동** |
| 맥 | 새 버전 알림 → 릴리스 페이지 열기 → dmg 수동 교체. (Apple 서명 없으면 macOS가 자동 설치를 막음) |

확인 주기: 앱 시작 10초 뒤 1회 + 이후 6시간마다. 트레이 메뉴 → **업데이트 확인…** 으로 수동 확인도 가능.

---

## 최초 1회 세팅

```bash
git init && git add -A && git commit -m "chore: 자동 업데이트 도입"
gh repo create kimseuseu/senbi-auto --public --source=. --remote=origin --push
```

저장소 이름이나 계정이 다르면 아래 세 곳을 같은 값으로 바꾼다.

- [package.json](package.json) → `build.publish` 의 `owner` / `repo`
- [electron/updater.cjs](electron/updater.cjs) → `RELEASES_URL`
- 이 문서

> 비공개 저장소로 하면 사용자마다 GitHub 토큰이 필요해 자동 업데이트가 사실상 불가능하다. **공개 저장소**로 둘 것. (`.env` 는 `.gitignore` 에 있으니 API 키는 올라가지 않는다)

## 새 버전 배포 (매번)

```bash
npm version patch && git push --follow-tags
```

`v*` 태그가 올라가면 [GitHub Actions](.github/workflows/release.yml)가 맥·윈도우를 각각 빌드해 릴리스에 올린다. 5~10분 뒤 릴리스 페이지에 이 파일들이 생기면 끝:

- `senbiPOST-Setup-<버전>.exe` + `latest.yml` — 윈도우 자동 업데이트용
- `senbiPOST-<버전>-arm64.dmg` / `-x64.dmg` + `latest-mac.yml` — 맥용

이후 사용자 앱은 6시간 안에(또는 다음 실행 시) 새 버전을 감지한다.

`npm version minor` / `major` 도 동일. 기능 추가면 minor, 버그 수정이면 patch.

## 로컬에서 직접 빌드해 올리고 싶을 때

```bash
GH_TOKEN=$(gh auth token) npm run release
```

맥에서 실행하면 맥 아티팩트만 올라간다. 윈도우 exe는 윈도우 머신이나 위 Actions에서 만들어야 한다.

## 주의점

- **이미 배포한 0.1.0 설치본은 자동 업데이트가 안 된다.** 자동 업데이트 정보(`app-update.yml`)가 없는 빌드라서, 그 사용자들은 다음 버전을 한 번만 수동으로 설치하면 그 뒤부터 자동이 된다.
- 윈도우 설치 시 SmartScreen 경고가 뜬다(코드 서명 미적용). "추가 정보 → 실행"으로 넘어간다. 없애려면 코드 서명 인증서(연 20~40만원)가 필요하다.
- 맥도 서명(Apple Developer, 연 $99)을 붙이면 윈도우처럼 완전 자동이 된다. 그때 [electron/updater.cjs](electron/updater.cjs) 의 `MAC_CODE_SIGNED` 를 `true` 로 바꾸고, Actions에서 `CSC_IDENTITY_AUTO_DISCOVERY: false` 를 제거한 뒤 인증서·공증 시크릿을 추가하면 된다.
- 버전은 항상 올려야 한다. 같은 버전으로 다시 올리면 업데이트로 인식되지 않는다.
