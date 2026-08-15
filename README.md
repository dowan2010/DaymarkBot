# auto-newrrow

뉴로우(dgsm.newrrow.com) 일일 회고를 터미널에서 자동으로 작성·제출하는 CLI.

## 설치

```bash
git clone https://github.com/dowan2010/DaymarkBot.git
cd DaymarkBot
npm install
npx playwright install chromium
```

## 실행

```bash
node cli.js
```

첫 실행 시 메뉴에서 **설정 (API 키 / 계정)** 선택 후 아래 값을 입력하면 `.env`에 저장됨.

- `GEMINI_API_KEY` — Google AI Studio에서 발급
- `EMAIL` / `PASSWORD` — 뉴로우 로그인 계정

이후엔 **오늘 회고 하기** 선택만 하면 주제·내용 AI 생성부터 자가점검·회고 작성·저장·공유·감사카드까지 전부 자동 처리됨.

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

## 참고

- 브라우저 창을 띄워서 보고 싶으면 `.env`에 `HEADLESS=false` 설정
- MIT License

## 문제 발생 시

먼저 `node -v`로 Node 버전이 맞는지 확인하고, `npm install` / `npx playwright install chromium`을 다시 실행해보세요.
그래도 안 되면 [Issues](https://github.com/dowan2010/newrrowBot/issues)에 등록해주세요.
