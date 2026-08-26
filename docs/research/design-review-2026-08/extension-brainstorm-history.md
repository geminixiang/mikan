# 從軟體生態史看 mikan extension 的價值與野心邊界

## 摘要

Extension 機制對 mikan 最大的好處，不是「讓第三方開發者變多」，而是把一個原本只能靠 fork、改 core、重部署才能演化的 chat agent，變成一個能在**不污染核心架構的前提下，累積組織特有工作流**的平台。

這種價值在小型部署尤其明顯：管理員通常也是開發者，真正稀缺的不是 marketplace、審核團隊或全球 distribution，而是：

- 能否用很低的成本把臨時自動化變成可維護的能力；
- 能否讓同一個 deployment 裡不同 conversation/office 使用不同功能；
- 能否升級 mikan core，而不必重新套用一疊私有 patch；
- 能否把 command、hook、schedule、platform UI、state 與 agent tools 放進同一個生命週期；
- 能否讓成功的內部實驗逐步產品化，而不是一開始就設計成大型 SaaS。

歷史上成功的 extension 生態，往往不是因為 API 最完整，而是因為它們找對了「最小可用閉環」：**發現需求 → 寫少量 code → 立即在原產品中運作 → 可分享、可升級、可停用**。失敗則常來自兩個極端：一是 extension 能力太弱，只能裝飾；二是 extension 等同在主程式裡執行任意 code，卻假裝已有安全隔離。

以下選四個最有啟發性的真實生態：Emacs packages、WordPress plugins、VS Code extensions、Slack apps。

---

## 一、Emacs packages：可塑性先於平台治理

### 為什麼它能起飛

Emacs 的關鍵設計不是 package manager，而是產品本身以 Lisp 建構，使用者與核心開發者操作的是近乎相同的語言與物件模型。Extension 不只是呼叫一組外部 API；它可以覆寫 command、掛 hook、改 keymap、增 major/minor mode，甚至重新定義既有函式。

這帶來三個飛輪：

1. **從個人片段到套件的坡度極低。** 一段 init file code 可以逐步長成 package，不必先建立服務、OAuth app或部署管線。
2. **extension 能完成端到端工作。** 它不是只能增加按鈕，而是可以改變編輯器的工作方式。
3. **核心不必預測所有工作流。** 特定語言、郵件、Git、筆記系統與研究工具可以在核心之外成熟。

Emacs 證明：對開發者工具而言，「可被使用者重塑」本身就是產品價值。很多功能先在 package 中演化，成功後才影響核心慣例。

### 它付出的代價

Emacs extension 的信任模型近乎「安裝即完全信任」。Package 與 init code 在使用者進程裡運作，能讀檔、啟動 process、連網、檢查所有 buffer。相容性也主要靠社群慣例：advice、覆寫內部函式、依賴載入順序，都可能在升級時失效。

它的 tenant model 基本上是 single-user、single-process。不同 profile 可以有不同 package，但沒有現代 SaaS 意義下的 organization、workspace、conversation owner，也沒有 capability consent。

### 對 mikan 適用的教訓

**適用：**

- 管理員多半是開發者時，低摩擦比宏大的 marketplace 更重要。
- Extension 必須能形成完整工作流：command + hook + schedule + state + tool，而不是只有一種 callback。
- 好的 golden path 應讓「一個檔案的實驗」自然長成可安裝 package。
- 核心應保持小，把組織特定政策、報表、triage、提醒、PM workflow留給 extension。
- Debuggability 是 adoption 的一部分：清楚的載入錯誤、log、validate、dev loop，往往比精緻權限 UI 更重要。

**不適用：**

- mikan 是 multi-tenant 且握有平台 token、vault、agent executor；不能照搬「所有 extension 完全信任且全域生效」。
- Chat agent 的副作用比編輯器高：它會發訊息、執行命令、讀 credential、排程未來行為。錯誤不只影響安裝者本人。
- Emacs 式任意 monkey patch 會讓每個 office 的行為不可推理；mikan 應提供明確 hooks，而不是鼓勵覆寫 core internals。

### 歷史類比給 mikan 的一句話

**學 Emacs 的可塑性與短 feedback loop，不要學它把完全信任當成沒有問題。**

---

## 二、WordPress plugins：極低安裝門檻創造生態，也創造永久攻擊面

### 為什麼它能起飛

WordPress plugins 的成功首先來自 distribution 與部署現實，而非 API 純度：大量站長只要上傳/安裝 zip、按 Activate，就能得到表單、SEO、電商、快取、會員、分析與內容工作流。Hooks、filters、短代碼、後台頁面與資料庫存取，讓 plugin 能提供完整商業功能。

幾個決定特別重要：

1. **安裝與啟用是分開的。** Code 可以存在，但站點管理員決定是否 activate。
2. **extension 有足夠權力完成 vertical solution。** WooCommerce 不是一顆按鈕，而是在 WordPress 上建立另一個產品層。
3. **共用主機、廉價部署與管理 UI 讓長尾需求有市場。** 不必等待 core 接受 feature。
4. **stable hooks 比漂亮抽象更有價值。** 生態依賴的是多年不消失的 integration points。

### 它如何失敗或累積技術債

WordPress plugin 通常與主程式共享 PHP process、filesystem、database與權限。安裝第三方 plugin 幾乎等同把第三方 code 放進網站的最高信任區。結果是：

- 一個脆弱 plugin 足以攻破整站；
- plugin 可直接讀寫其他 plugin 的 table/options/files；
- hook ordering、全域 state、database schema與版本相容性造成組合爆炸；
- plugin 停用或刪除後常留下 tables、options、cron jobs；
- 「能做任何事」讓 platform 很強，也讓真正的 capability boundary 很弱。

其 tenant model 以「一個 WordPress site」為主要邊界。WordPress Multisite 後來增加 network admin、network activation與site activation，暴露出一個重要事實：**network install、network-wide activation、site availability與site activation不是同一件事。** Super admin 可以提供 plugin，但是否每個 site 都該啟用，是另一個 policy 問題。

### 對 mikan 適用的教訓

**適用：**

- 安裝 code 與啟用功能必須分離。這是 mikan extension tenancy 最直接的歷史類比。
- Global install 不應自動等於所有 office activation；WordPress Multisite 已經示範 network scope 與site scope不可混為一談。
- Extension lifecycle 必須包括 disable/uninstall 後的 schedule、state、secret與registration 行為。
- Stable extension identity、schema migration與版本相容性越晚補，成本越高。
- 讓 extension 完成一個 vertical workflow 是好事，但必須知道這代表更大的 blast radius。

**不適用：**

- mikan 現階段不需要複製 WordPress marketplace、付費授權、數十萬 plugin 的 compatibility governance。
- 小型、管理員即開發者的部署，可先採「trusted code catalog」而不是建立完整審核商店。
- 不必為假想中的 anonymous plugin author 犧牲 API 清晰度；先服務可審 code、可讀 source 的內部 extensions。

### 歷史類比給 mikan 的一句話

**WordPress 證明強 extension 可以把產品放大十倍，也證明 in-process arbitrary code 永遠不能被包裝成細粒度安全。**

---

## 三、VS Code extensions：用清楚的 contribution model 與 process boundary 擴大生態

### 為什麼它能起飛

VS Code 並不是第一個可擴充編輯器，但它把幾個歷史教訓組合得很好：

1. **Declarative contributions。** Commands、languages、grammars、menus、keybindings、configuration等先在 manifest 宣告，產品可在不執行 extension code 前建立 UI與索引。
2. **Activation events / lazy loading。** Extension 不必在啟動時全部執行；只有相關語言、command或workspace條件出現時才 activate。
3. **Extension host process。** Extension 不是直接跑在 renderer UI process；崩潰與效能問題至少有一定隔離，remote development 又進一步明確區分 local UI 與remote workspace execution。
4. **穩定、文件化、型別化的 API。** 大部分 extension 不必碰 internal objects。
5. **Golden-path 工具完整。** Scaffold、debug extension host、reload、marketplace、版本與相容性欄位，把開發到distribution變成一條短路徑。

它的成功不只是 marketplace 大，而是 extension author 能迅速回答三個問題：我能貢獻什麼？何時被啟動？code 在哪裡執行？

### Tenant 與信任模型如何演化

早期桌面編輯器仍偏 single-user trust。後來幾個壓力迫使模型演化：

- Remote SSH、containers、Codespaces 讓「UI 所在機器」與「workspace code 所在機器」分離；extension 需要標示適合在哪一側運作。
- Workspace Trust 出現，是因為只要開啟陌生 repository，某些 extension/task/debug設定就可能執行 code。
- Enterprise policy 逐漸需要 allowlist、denylist與私有 distribution。
- Extension host 雖是 process boundary，卻不是完整安全 sandbox；extension 仍可能擁有廣泛 filesystem/network能力。

這段歷史很重要：VS Code 沒有一開始就設計出完整 multi-tenant capability security，而是在 distribution、remote execution與供應鏈風險成長後逐步補上 trust surfaces。

### 對 mikan 適用的教訓

**適用：**

- Manifest declarations 很有價值。`requires`、commands、schedules、config schema、secrets與可能的activation intent，應盡量在 import 前可檢查。
- 「何時 activate」應成為正式概念，而不是掃到 code 就執行的偶然行為。
- Host/control-plane extension 與office executor中的工作應明確區分，類似 local extension host 與remote workspace extension。
- Capability contract 的首要價值是 compatibility、diagnostics與可部署性；若 code 仍在 host process，它不是安全 sandbox。
- Scaffold、validate、dev loop與範例會比先建 marketplace 更能催生實際 extensions。
- Extension 卡死或洩漏資源終究會推動 process isolation；現在應避免設計只能永遠 in-process 的 API。

**不適用：**

- mikan 不需要 VS Code 等級的數百個 contribution points。太早擴大 API 會凍結錯誤抽象。
- 不需要立即建立 public marketplace、review pipeline與跨作業系統桌面相容矩陣。
- VS Code 的每位使用者多半控制自己的 extension set；mikan 一個 office 可能被多人驅動，啟用權限不能簡單等同「目前使用者按 Install」。

### 歷史類比給 mikan 的一句話

**學 VS Code 把 manifest、activation、execution location 與開發工具做成清楚契約；不要照抄它的 API 面積與 marketplace 規模。**

---

## 四、Slack apps：從 workspace install 走向 organization governance，證明 chat integration 的 tenant 不是單一層級

### 為什麼它能起飛

Slack apps 的力量來自它們在工作發生的地方出現。Slash commands、events、interactive components、bots、home tabs、OAuth scopes與webhooks，讓第三方服務不用把使用者拉到另一套 UI，就能嵌入團隊協作。

讓生態起飛的設計包括：

1. **OAuth scopes 是可理解的能力聲明。** 安裝時管理員至少能看到 app 想讀/寫什麼。
2. **事件與互動模型是hosted integration。** App 不必進入 Slack process；Slack 傳送 events，app透過API回應。
3. **Workspace 是早期清楚的 installation tenant。** Token、installation與資料通常按 workspace 分區。
4. **Commands、buttons與messages形成閉環。** App 能從觸發到呈現結果都留在 conversation surface。
5. **平台控制 distribution、token撤銷與速率限制。** 第三方服務故障不等同 Slack 主程式崩潰。

### Tenant 與信任模型如何演化

Slack 從單一 workspace 管理逐漸走向 Enterprise Grid、organization-level app management、admin approval與跨workspace安裝。這揭示多層 tenancy 的現實：

- 開發者建立一個 app definition；
- organization admin 決定是否允許；
- workspace admin 安裝；
- channel/user 與 app互動；
- token scope可能是 bot、user或organization；
- 有些行為由conversation觸發，有些由event、cron或外部系統觸發。

Slack 也展示 scopes 的限制：scope 能描述 API 權限，卻不能完整描述 app 如何保存、關聯或外洩資料。Scopes 是必要的 consent surface，不是完整安全證明。

另一個教訓是 platform app distribution 的營運成本：OAuth、token rotation、event delivery retries、rate limit、review政策、資料保留與企業管理會迅速變成產品本身。

### 對 mikan 適用的教訓

**適用：**

- Chat agent extension 的自然價值就是把內部系統與工作流帶進conversation，而不是增加更多獨立 dashboard。
- Capability declaration 應像 scopes 一樣讓管理員知道 extension 需要 messaging、Block Kit、secrets、subagent或schedules中的哪些能力。
- Tenant 不能只叫「global」與「local」；至少要分 deployment trust、office activation、platform identity與必要時的shared service authority。
- 無聊天訊息觸發的 schedule 仍需要 owner/principal。它可能屬於某 office activation，也可能是獨立 deployment service，不能因為「沒有當前 user」就沒有tenant。
- Commands、interactive messages、schedule callbacks與agent tools若共享同一 extension identity和lifecycle，會形成很強的產品閉環。

**不適用：**

- mikan 不應短期追求 Slack App Directory 式 public SaaS integration marketplace。
- 不需要為每個 extension 建立獨立OAuth SaaS安裝流程；多數 deployment admin 能直接審 code、提供secret與重啟服務。
- Slack 的hosted app isolation來自網路邊界與獨立服務；mikan 若仍 import extension 到host process，不能只模仿scope命名便宣稱得到同等隔離。
- 大型enterprise organization policy、法遵審核與跨workspace app管理，對現階段部署規模多半過重。

### 歷史類比給 mikan 的一句話

**學 Slack 的 tenant-aware installation、capability consent與conversation-native workflow；不要把自己拖進公共 SaaS app platform 的營運黑洞。**

---

## 五、四個生態共同說明了什麼

### 1. Extension 的首要價值是解除 core roadmap 的瓶頸

Emacs、WordPress、VS Code與Slack的共同成功點，不是第三方數量，而是核心團隊不必成為所有垂直需求的排程中心。

對 mikan 而言，extension 可承接：

- 組織內部 triage與approval；
- issue/PR/channel 的同步工作流；
- 定期報表、提醒與追蹤；
- 專用agent tools和context policy；
- 平台互動元件；
- 特定domain的stateful application。

沒有 extension，這些能力只能三選一：塞進 core、fork mikan、或在外部另建一個bot。三者都會增加長期整合成本。

### 2. 最有價值的 extension 不是「一個 hook」，而是一個小型應用

歷史上能產生長期價值的extension通常跨越多個surface：

- WordPress plugin同時有hook、admin UI、database與cron；
- VS Code extension同時有command、language service、configuration與workspace state；
- Slack app同時有events、commands、interactive UI與external service；
- Emacs package同時有mode、commands、hooks、keymaps與buffers。

因此 mikan 把 commands、hooks、schedules、state、platform messages、Block Kit、skills與tools放在同一 extension lifecycle 下是正確方向。這能讓extension成為「一個conversation-native app」，而不是零散callback集合。

### 3. 安裝、可用、啟用、執行與授權必須逐步拆開

四個生態都曾因早期將這些概念混在一起而補課：

- Emacs：package存在通常就是完全trusted code；
- WordPress：network/site scope迫使install與activation分層；
- VS Code：activation events、remote execution與Workspace Trust逐步出現；
- Slack：organization approval、workspace installation、token scopes與user interaction形成多層治理。

Mikan 不必一次完成所有治理，但資料模型與術語應避免把未來鎖死。最小合理分層是：

1. deployment admin批准code/artifact；
2. deployment policy決定哪些office可看見或預設啟用；
3. office owner決定office activation與設定；
4. extension manifest宣告所需capabilities；
5. runtime以activation principal解析state、schedule、secrets與executor；
6. 真正跨office服務使用獨立service principal。

### 4. Capability manifest 的早期價值不是防惡意code

Slack scopes與VS Code manifests容易讓人誤以為「有宣告就安全」。其實如果extension仍能執行任意host code，manifest最先提供的是：

- 啟動前相容性檢查；
- 清楚錯誤訊息；
- 管理員理解 blast radius；
- 未來隔離與policy enforcement的穩定詞彙；
- 測試與文件可依賴的contract。

這已經很有價值，但應誠實稱為contract/consent，不是假裝成sandbox。

### 5. Extension 生態最容易被糟糕 DX，而不是缺 marketplace，扼殺

小型開發者主導的專案，早期死亡原因通常是：

- 不知道entrypoint怎麼寫；
- 修改後不知道何時reload；
- activation失敗只有一行模糊log；
- state和schedule殘留無法理解；
- 本地測試必須先架Slack/Discord；
- API文件與範例展示不同年代的做法；
- core升級後extension靜默失效。

因此 mikan 的高報酬投資順序應是：scaffold、validate、local dev harness、golden examples、typed API、清楚 lifecycle、diagnostics、compatibility version；不是先建商店。

---

## 六、哪些規模教訓不適用於 mikan

Mikan 的典型環境是小部署、少量管理員、管理員多半能寫code並審source。這使它與數百萬使用者的公共平台有根本差異。

### 不應過早複製的東西

1. **Public marketplace治理**：審核、排名、付款、惡意套件偵測、商標與下架流程。
2. **完整第三方開發者平台承諾**：長期凍結大量API、維護多世代相容層。
3. **細碎到令人無法工作的permission prompts**：管理員已在部署層信任code時，過度prompt只會製造儀式感。
4. **每個extension都是遠端SaaS**：會帶來OAuth、webhook reliability、billing與資料處理責任。
5. **假想的大規模排程與storage backend抽象**：先有真實的第二個backend和可測需求，再深化介面。
6. **一開始就防所有惡意extension**：若短期明確定位為admin-reviewed trusted code，應先防誤用、scope錯置與事故；真正惡意隔離需要process/runtime設計，不是更多TypeScript介面。

### 即使規模小也不能省略的東西

1. office identity與資料隔離；
2. install和activation的語義分離；
3. code/state/secrets/schedules的清楚生命週期；
4. required capabilities的import前檢查；
5. schedule owner/principal；
6. extension失敗不能破壞整個conversation runtime；
7. 可重現的版本與upgrade path；
8. 明確承認in-process extension是trusted host code。

小規模可以降低治理成本，不能取消authority model。因為一個錯誤extension仍可能接觸所有platform token與host filesystem，事故規模不會因安裝者只有兩人而自動變小。

---

## 七、mikan extension 的合理野心水位

## 它應該想成為什麼

### 1. 「自架chat agent的內部應用SDK」

Mikan extension 最合理的定位，不是通用插件商店，而是：

> 讓一個小團隊能在幾十到幾百行code內，把自己的工作流、資料與agent能力做成conversation-native application，並能跟著mikan升級，而不必fork core。

這比「plugin」更接近小型內部應用：它可以有commands、hooks、tools、schedules、state、interactive UI和skills，但由mikan提供conversation、platform、agent、executor與lifecycle骨架。

### 2. 「core feature的試驗田」

Extension 應是新功能進入核心前的低成本演化場：

- 先以extension驗證需求；
- 若只對少數部署有用，就永遠留在extension；
- 若多個獨立extension重複同一能力，再考慮深化host API；
- 若功能成為所有部署的基礎不變量，才進core。

這能保護mikan核心不被每個客製需求侵蝕。

### 3. 「少量、可審、可組合的trusted extensions」

合理目標不是一個deployment裝五百個未知plugin，而是裝5–20個有明確owner、source、版本與用途的extensions。管理員能讀code，office owner能控制activation，系統能清楚顯示capabilities、state與schedules。

在這個水位，很多昂貴問題都可延後，但API仍需保持未來可移出process。

### 4. 「跨平台conversation能力的統一層」

Mikan 真正稀有的資產不是extension loader，而是它已統一Slack、Discord、Telegram與GitHub的conversation runtime、session、office、sandbox與agent tools。Extension應利用這個統一層，讓同一個workflow只在必要處處理platform差異。

這是它相對於「每個平台各寫一個bot」最實際的優勢。

## 它不該妄想成為什麼

### 1. 不要妄想短期成為另一個 Slack App Directory 或 VS Code Marketplace

沒有龐大安裝基數、獨立第三方作者群、審核營運與商業distribution需求時，marketplace只是昂貴空殼。先讓repository內與private git packages好用。

### 2. 不要妄想 capability manifest 已把任意code變安全

只要extension仍在mikan host process內執行，它就是deployment-trusted code。真正的untrusted ecosystem需要out-of-process execution、IPC capabilities、resource limits、network/filesystem policy、簽章與supply-chain治理。

這可以是遠期方向，但不應以命名或文件假裝已完成。

### 3. 不要妄想成為通用 serverless automation platform

Zapier式產品需要connector catalog、credential brokering、workflow editor、retry/idempotency engine、billing、observability與大規模task execution。Mikan可支援extension內workflow，但不應把核心改造成通用iPaaS。

當workflow主要價值不在conversation或agent context時，應由外部系統負責，mikan只做觸發與呈現。

### 4. 不要妄想所有跨office需求都能塞進sharedDataDir

真正跨office app需要shared ownership、authorization、concurrency、retention與service schedules。它不是「在global目錄放一個SQLite檔」就完成tenant model。少數需要它的extension應以顯式shared service activation處理。

### 5. 不要妄想API越多，生態越健康

健康生態依賴少數穩定、能組成完整閉環的deep APIs。每多一個host surface，就增加相容性、安全、測試與文件責任。應從真實extension需求反推API，而不是先複製其他平台的功能清單。

---

## 最後判斷

Mikan extension 最值得追求的歷史位置，介於Emacs與VS Code之間，借用WordPress與Slack的治理教訓：

- 像Emacs一樣，讓管理員/開發者能快速重塑產品；
- 像VS Code一樣，用manifest、activation、execution location與tooling建立可理解契約；
- 記住WordPress的警告：強大的in-process plugin就是完全trusted code，install與site activation必須分離；
- 借用Slack的tenant觀：deployment approval、office activation、platform credentials與schedule principal是不同層次。

它的合理野心是成為**最好用的self-hosted、multi-platform、conversation-native internal app SDK**：讓小團隊不fork core就能建立自己的agent工作流。

它不該妄想在當前規模成為公共插件經濟、通用automation SaaS或安全執行陌生第三方code的平台。若未來真有足夠distribution與作者需求，再用實際壓力推動out-of-process extension host、artifact governance與marketplace；不要提前支付一個尚不存在的生態成本。
