# Talkpen

영어·일본어 회화 연습 앱. GitHub Pages + Google 로그인 + Firestore. 답은 내 PC에서 돌아가는 클로드 세션이 단다.

- `index.html` — 앱 화면 (마이크로 말하기, 뜻 통했는지 / 원어민 표현 / 대화)
- `SESSION.md` — 답하는 클로드 세션이 읽을 지침
- `tools/talkpen.js` — 세션이 Firestore를 읽고 쓰는 도구 (의존성 없음, 서비스 계정 키 필요)

## 흐름

1. 페이지: 🎤로 말하면 `english_turns`에 `{role:"user", text, answered:false, ...}` 저장
2. 📞 호출: 페이지가 `english_state/live`에 켜짐 표시 → PC 세션의 `node tools/talkpen.js watch` 가 2초마다 확인 → `CALL english <json>` 출력 (■ 종료하면 20초마다 스위치만 확인)
3. PC 세션: `pending` 으로 읽고 `add` 로 `{role:"ai", re:<id>, ...}` 저장 (사용자 턴은 `answered:true`)
4. 페이지: 실시간으로 받아서 표시

## Firestore 규칙

사용자는 두 명(나, 아내). 각자 자기 대화만 읽고 쓴다.

```
function talkpenUser() {
  return request.auth != null && request.auth.token.email in ["foodkarshiva@gmail.com", "eori211204@gmail.com"];
}
match /english_turns/{id} {
  allow read, update, delete: if talkpenUser() && resource.data.email == request.auth.token.email;
  allow create: if talkpenUser() && request.resource.data.email == request.auth.token.email;
}
match /english_state/{id} {
  allow read, write: if talkpenUser() && id == "live_" + request.auth.uid;
}
```

서비스 계정 키는 이 저장소에 절대 올리지 않는다. 경로는 환경변수 `TALKPEN_SA`.
