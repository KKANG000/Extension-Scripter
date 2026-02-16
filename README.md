# Script Supervisor (Scripter)

SillyTavern용 장면/서사 관리 확장입니다.  
현재 장면과 다음 장면을 분리해 운영하고, 생성 직전에 시스템 프롬프트를 주입해 응답 품질과 일관성을 유지하도록 설계되었습니다.

- 현재 버전: **1.2.0**
- 저장소: https://github.com/KKANG000/Extension-Scripter

## 핵심 기능

1. **장면 구조화**
   - `Current Scene (Main)` / `Next Scene (Teaser)` 분리 작성
   - `Caution`, `Core Principle` 보조 필드 제공
2. **상태 제어**
   - `READY`, `ACTION`, `MONTAGE` 전환
   - `MONTAGE` 활성 시 `READY/ACTION` 버튼 비활성화
3. **CUT! 전환 + 롤백**
   - CUT 실행 시 `Next -> Current`, `Queue 첫 항목 -> Next`
   - 전환 직전 상태를 1회 롤백 가능
4. **Queue 관리**
   - 장면 추가/수정/순서 이동/삭제/전체 비우기
   - TXT import/export 지원 (`---` 구분자)
5. **프롬프트 주입**
   - 생성 시작 시점에 확장 프롬프트 자동 주입
   - 채팅별 ON/OFF 토글(프롬프트만 비활성화 가능)
   - `Final Check` 프롬프트 사용자 커스터마이징
6. **퀵버튼**
   - 입력창 옆 버튼 제공 (표시 ON/OFF 가능)
   - 클릭/더블클릭 동작 개별 지정:
     - 사이드바 열기
     - 프롬프트 전송 토글
     - CUT! 실행
     - 더블클릭 비활성화
   - 프롬프트 OFF 시 퀵버튼에 대각선 슬래시 표시
7. **UI/UX**
   - 사이드바 좌/우 위치 전환
   - 자동 너비 조절(최소 350px) + 너비 초기화 버튼
   - 사이드바 <-> 센터 팝업 동기 편집
8. **단축키**
   - `Ctrl+Shift+C`: **CUT! 실행**

## 설치

1. 이 폴더를 SillyTavern의 `public/scripts/extensions/third-party/` 아래에 복사
2. 경로가 `public/scripts/extensions/third-party/Extension-Scripter/` 형태인지 확인
3. SillyTavern 재시작(또는 새로고침)
4. 확장 메뉴에서 `Scripter` 활성화

## 빠른 시작

1. 확장 메뉴(마법봉)에서 `Scripter`를 눌러 사이드바 열기  
   또는 퀵버튼 기본 클릭(사이드바 열기) 사용
2. `Current Scene`, `Next Scene` 입력
3. 필요 시 `Caution`, `Core Principle` 입력
4. 상태(`READY/ACTION/MONTAGE`) 설정
5. 장면 전환 시 `CUT!` 버튼 또는 `Ctrl+Shift+C` 사용
6. Queue가 있으면 CUT 시 자동으로 다음 항목이 `Next Scene`으로 승격

## 프롬프트 동작 방식

1. 생성 시작 이벤트에서 확장 프롬프트를 주입합니다.
2. 아래 조건이면 주입하지 않습니다.
   - 확장 전체 비활성화
   - 채팅별 프롬프트 토글 OFF
3. 상태에 따라 프로토콜이 달라집니다.
   - `READY`: 장면 진입/브릿지 중심
   - `ACTION`: 진행 중 장면의 미세 전개 중심
   - `MONTAGE`: 시간 압축 전개 중심
4. `Final Check` 블록은 설정 패널에서 저장/초기화할 수 있습니다.

## 설정 항목

| 카테고리 | 항목 | 설명 |
|------|------|------|
| 기본 설정 | 스크립터 활성화 | 확장 전체 ON/OFF |
| 기본 설정 | 테마 | `Default` / `Glassmorphism` |
| 인터페이스 | 사이드바 위치 | 오른쪽 / 왼쪽 |
| 인터페이스 | 자동 너비 | 채팅 레이아웃 기준으로 사이드바 너비 자동 계산 |
| 인터페이스 | 너비 초기화 | 사이드바 너비를 350px로 리셋 |
| 퀵버튼 | 퀵버튼 표시 | 입력창 옆 버튼 표시 여부 |
| 퀵버튼 | 클릭 동작 | 사이드바 / 전송토글 / CUT! |
| 퀵버튼 | 더블클릭 동작 | 전송토글 / 사이드바 / CUT! / 비활성화 |
| 단축키 | Ctrl+Shift+C 활성화 | CUT! 단축키 사용 여부 |
| 프롬프트 | Final Check 프롬프트 | 저장/초기화 지원 |
| 데이터 | 데이터 초기화 | 현재 채팅의 Scripter 데이터 초기화 |

## Queue 파일 포맷

- Export 파일명: `scripter_queue.txt`
- 구분자: 한 줄 `---`
- 예시:

```txt
scene 1
---
scene 2
---
scene 3
```

## 데이터 범위

1. **채팅별 데이터**
   - 상태(`status`, `montage`, `autoAction`, `promptEnabled`)
   - 텍스트 필드(`caution`, `currentScene`, `nextScene`, `corePrinciple`)
   - `queue`, `rollbackData`
2. **전역 설정**
   - 확장 ON/OFF, 테마, 사이드바 위치, 퀵버튼/단축키 설정, Final Check 프롬프트
3. **주의**
   - 설정의 `데이터 초기화` 버튼은 현재 구현상 **현재 채팅 데이터만** 초기화합니다.

## 변경 요약 (v1.2.0)

1. 프롬프트 토글(채팅별)과 퀵버튼 시각 상태(OFF 슬래시) 추가
2. 사이드바 좌/우 위치 설정 추가
3. 퀵버튼 클릭/더블클릭 동작 커스터마이징 추가
4. 설정 UI 카테고리 재구성 및 스타일 개선
5. CSS 단위/변수 정리와 이벤트 처리 최적화
