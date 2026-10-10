# Talkpen

영어·일본어 회화 연습 앱. GitHub Pages + Google 로그인 + Firestore. 답은 내 PC에서 돌아가는 클로드 세션이 단다.

- `index.html` — 앱 화면 (마이크로 말하기, 뜻 통했는지 / 원어민 표현 / 대화)
- `SESSION.md` — 답하는 클로드 세션이 읽을 지침
- `tools/talkpen.js` — 세션이 Firestore를 읽고 쓰는 도구 (의존성 없음, 서비스 계정 키 필요)

## 흐름

1. 페이지: 🎤로 말하면 `english_turns`에 `{role:"user", text, answered:false, ...}` 저장
2. PC 세션: `node tools/talkpen.js watch 15` 가 15초마다 미응답 턴을 확인 → `CALL english` 출력
3. PC 세션: `pending` 으로 읽고 `add` 로 `{role:"ai", re:<id>, ...}` 저장 (사용자 턴은 `answered:true`)
4. 페이지: 실시간으로 받아서 표시

## Firestore 규칙 (추가 필요)

```
match /english_turns/{id} {
  allow read, write: if request.auth != null && request.auth.token.email == "foodkarshiva@gmail.com";
}
```

서비스 계정 키는 이 저장소에 절대 올리지 않는다. 경로는 환경변수 `TALKPEN_SA`.
