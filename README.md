# 유튜브 자동 건너뛰기

PC용 Chrome에서 유튜브 광고의 **건너뛰기 버튼이 표시되고 클릭할 수 있을 때** 자동으로 누르는 확장 프로그램입니다. 설치 후 기본값은 켜짐이며, 확장 프로그램 아이콘에서 끄거나 다시 켤 수 있습니다.

## 설치

1. Chrome 주소창에 `chrome://extensions`를 입력합니다.
2. 오른쪽 위 **개발자 모드**를 켭니다.
3. **압축해제된 확장 프로그램을 로드합니다**를 누릅니다.
4. 이 `youtube-auto-skip` 폴더를 선택합니다. `manifest.json`이 바로 들어 있는 폴더여야 합니다.
5. 이미 열려 있던 유튜브 탭은 새로고침합니다.
6. 필요하면 Chrome 도구 모음의 퍼즐 아이콘에서 **유튜브 자동 건너뛰기**를 고정합니다.

폴더는 설치 후에도 같은 위치에 보관해야 합니다. ZIP 파일을 받은 경우 먼저 압축을 풀고 설치하세요.

## 동작 범위

- `https://www.youtube.com/`에서 동작합니다.
- 영상 시작 전이나 재생 중에 광고 건너뛰기 버튼이 나타나면 클릭합니다.
- 숨김, 비활성화, 광고 외 영역의 버튼은 클릭하지 않습니다.
- 유튜브 안에서 영상을 바꾸거나 전체 화면으로 전환해도 계속 감지합니다.
- 끄기/켜기 설정은 이 브라우저에 저장되며 열려 있는 유튜브 탭에도 적용됩니다.
- 건너뛰기 버튼이 없는 광고와 버튼이 활성화되기 전 대기 시간은 그대로 유지됩니다.
- 광고 차단이나 영상 재생 시간 변경 기능은 없습니다.

유튜브 화면 구조가 바뀌면 `content.js`의 `SKIP_SELECTOR`를 수정해야 할 수 있습니다. 실제 광고는 계정·지역에 따라 달라지므로 본인 브라우저에서 동작을 확인하세요.

## 권한과 데이터

유튜브 페이지에서 실행할 콘텐츠 스크립트와 켜기/끄기 저장을 위한 `storage` 권한만 사용합니다. 외부 서버에 요청하거나 시청 기록, 쿠키, 계정 정보를 수집하지 않습니다. 별도 빌드나 패키지 설치 없이 위 파일을 바로 로드하면 됩니다.

Chrome의 공식 [확장 프로그램 설치 안내](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked) 및 [콘텐츠 스크립트 문서](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)를 참고했습니다.

## Git push로 배포

저장소: https://github.com/knj-arch/youtube-auto-skip

공개 개인정보 처리방침: https://knj-arch.github.io/youtube-auto-skip/

`main` 브랜치에 관련 파일을 push하면 GitHub Actions가 아래 작업을 수행합니다.

- `store/privacy.html` 변경: 개인정보 처리방침을 GitHub Pages에 게시합니다.
- 확장 프로그램 코드·아이콘 변경: 업로드용 ZIP을 만들고 Actions 실행의 첨부 파일로 저장합니다.
- 웹 스토어 API 설정이 연결된 경우: ZIP 업로드 후 심사에 제출합니다. 승인되면 기존 배포 범위로 게시됩니다.

처음에는 개발자 등록과 첫 스토어 항목 작성이 필요합니다. GitHub 저장소 설정에도 API 연결 정보를 한 번 입력해야 합니다. 자세한 순서는 `store/automation-cws.txt`와 `store/install-and-submit.txt`에 있습니다.

소스의 기본 버전은 `manifest.json`의 세 자리 버전이며, CI에서 GitHub 실행 번호를 네 번째 숫자로 추가합니다. 예를 들어 소스 `1.0.0`과 실행 번호 `12`는 스토어 패키지 `1.0.0.12`가 됩니다. 새 push마다 새 버전이 만들어집니다. API 연결 전에는 스토어 업로드를 건너뛰고 ZIP 생성까지만 진행합니다.

업로드 패키지를 로컬에서 만들려면 PowerShell에서 `./build-store-package.ps1`을 실행합니다. ZIP은 `dist/`에 생성되며 `manifest.json`이 압축 파일 최상위에 위치합니다. 이미지 및 제출 문서는 패키지에 포함되지 않습니다.
