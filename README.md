# auto-newrrow

뉴로우(dgsm.newrrow.com) 일일 회고 터미널 자동화 CLI.
카드형 터미널 UI. 번호만 누르면 즉시 실행(엔터 불필요).

## 설치

```bash
git clone https://github.com/dowan2010/newrrowBot.git
cd newrrowBot
npm install
npx playwright install chromium
npm link
```

설치 끝, 이제 어디서든 `newrrow`.

## 실행

```bash
newrrow
```

전역 명령어 싫으면 `node cli.js`.

첫 실행 → 메뉴 **설정 (API 키 / 계정)** → 아래 값 입력 → `.env`에 저장됨.

- `GEMINI_API_KEY` — Google AI Studio 발급
- `EMAIL` / `PASSWORD` — 뉴로우 계정

이후 **오늘 회고 하기** 하나면 끝. 주제·내용 생성부터 자가점검·작성·저장·공유·감사카드까지 전부 자동.

## 메뉴

| 번호 | 기능 |
|---|---|
| 1 | 오늘 회고 하기 |
| 2 | 회고 초기화 |
| 3 | 할일 목록 보기 |
| 4 | 할일 추가 |
| 5 | 일정 등록 |
| 6 | 주제 추천만 보기 |
| 7 | 설정 (API 키 / 계정) |
| 0 | 종료 |

## 참고

- 브라우저 창 보고 싶으면 설정(7)에서 켜고 끄기 (`.env`의 `HEADLESS`)
- MIT License

## 문제 발생 시

1. `git pull origin main` — 최신 버전 확인
2. `node -v` — Node 버전 확인
3. `npm install` / `npx playwright install chromium` 재실행

안 되면 [Issues](https://github.com/dowan2010/newrrowBot/issues) 등록.
