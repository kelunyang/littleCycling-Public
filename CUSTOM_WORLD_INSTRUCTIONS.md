# 自訂世界製作指南

> 給 fork 這個專案、想做一套自己的視覺世界的人（以及你的 LLM）。

littleCycling 內建三套完整世界：**積木 plastic** / **瓦楞紙 cuphead** / **電子 circuit**。
（電子是三套裡唯一**真的照著移植流程走過一遍**的 —— demo 先、strategy 後，2730 行一次到位。
另外兩套的 strategy 檔比 demo 還早兩天出生，那是後面所有落差的來源，見
`plan/DEMO_POC_GUIDE.md` §2。）這份文件把「怎麼從零長出第三套世界」的流程、法則、預算與驗收方式寫下來
——包含我們自己踩過而且**代價很高**的坑。

## 0.0 最重要的一條：**demo 就是 POC，它的程式碼會被直接搬進前端**

`plan/*-demo.html` **不是原型、不是草稿、不是參考實作。** 它是概念驗證，
**一旦跑得動，那份程式碼就直接移植進 gameview**。

這件事只有一個推論，但它一再被忘記：

> **demo 裡的函式不是「給 gameview 照著重寫的參考」，
> 它就是「gameview 最後應該要含有的那段程式碼」。**

每次忘記，發生的事都一樣 —— 有人讀 demo、理解形狀，然後對著 gameview 的介面
寫出自己的版本。**它每次都看起來對，而且每次都不一樣。**

已經發生過的實例，塑膠世界的杯塔：

| | demo | 重寫出來的 |
|---|---|---|
| 錐度 | `1.12 / 1.62` = 0.6914 | 0.700 |
| 圓周分段 | 14 | 8 |
| 杯口環 | 有 | **整個掉了** |
| 網格 | `round(w / 3.5) - L` | `min(3, round(w / 6)) - L` |

沒有任何東西記錄這些偏離，也沒有任何東西抓得到。而**開發者是照著那份幾何去
接窗戶與招牌的錨點的** —— 幾何被重新推導，那些位置就靜靜地失效了。

### 所以做法是

1. **照抄。** 把 demo 的函式連同它呼叫的 helper 一起搬過來，變數名、magic
   number、rng 抽取順序全部保留。保留名字不只是禮貌 —— 那是「它被抄過來」
   最清楚的證據，也讓下一次比對變便宜。
2. **只在真的擋住的地方改，而且要寫下為什麼。** 上面那個杯塔的例子裡，唯一
   真正擋住的是 renderer 寫死的 `PART_CONE_TAPER` / `PART_CONE_SEGMENTS`
   —— 已經拿掉了，改成 style 自己宣告 unit 幾何（`buildPartTemplate?`）。
   注意 demo 的 `THREE.Group` of `InstancedMesh` **是它自己的批次，不是它的
   模型**；`BoxPart[]` 本來就是同一個形狀。
3. **不准預先最佳化。** 先把 demo 的值放回去再量。draw call 與三角形在實測
   上都跟幀時間零相關（見 `plan/migrate-demo-worlds.md` §5），砍下去多半是
   拿保真度換零。留下來的每一項裁減，都要把量到的數字寫進斷言。
4. **demo 的公式沒有下界。** 它的道具永遠有尺寸；真實路線會餵
   `box.height = 0`，除下去就是 `Infinity` → 4 GB heap 爆掉。要擋，而且註解
   要寫「因為路線會給零」。
5. **驗證是「執行 demo 的原始碼再比對」**，不是比對抄過來的常數 —— 抄過來的
   常數只會把當初打錯的東西再確認一遍。做法見 `scripts/headless-check/diorama.ts`
   的 `checkCelestialDiscs` / `[zone bodies vs demo]`：把 demo 的函式從 HTML
   切出來執行，用 `Math` shim 對齊 rng，逐件比對。
6. **demo 會改，而移植不會自己跟上。** 塑膠金幣在 demo 裡從素金圓片變成撲克籌碼
   （demo 自己寫「積木圓片太弱了」），gameview 留著舊的；瓦楞紙的 checkpoint
   demo 刪掉了空白便利貼，移植兩個都留著。**「照抄」是一次性的動作，「還是一樣」
   不是** —— 只有第 5 點那種逐件比對才維持得住，因為它執行的是 demo 的**當下**
   程式碼。
7. **三個 demo 可能互相矛盾，而且沒有東西看得見。** 只有塑膠問過招牌朝哪邊，
   另外兩個的字朝著行進方向、騎士永遠看不到。反過來，`normalBias` 是
   plastic/paper 1.5、circuit **1.2**，那是有理由的分歧 —— 所以**刻意的不一致
   也要被斷言下來**，不然下一個人會默默「修好」它。

### 隨時可以問「還差多少」

```
node scripts/headless-check/demo-coverage.mjs [--verbose]
```

逐個世界列出 demo 的造型函式有沒有對應物。它靠**指紋（函式體裡的 magic
number）**比對而不是靠名字 —— 名字會在移植中改掉，數字不會。

⚠ 它是**清點不是保真度檢查**：`present` 只代表「有東西在」，畫得一不一樣要靠
上面第 5 點那種逐件比對。而且大檔案會有數字巧合，所以 `present` 偏樂觀、
`absent` 才是可信的那一半。

真正證明「畫得跟 demo 一樣」的是：

```
npm run check:3d
```

**新增獨立的 `*-vs-demo.ts` 時要在 `diorama.ts` 的 `STANDALONE_CHECKS` 加一行。**
旁邊有一條守門的斷言會抓「磁碟上有、表上沒有」—— 那條是因為六支檢查檔（兩百多條
斷言）在自己的註解裡寫了「請這樣註冊」然後躺了好幾天沒人照做才加的。

---

## 0. 怎麼用這份文件

先讓你的 LLM 讀完這三份，缺一份它就會開始猜：

| 檔案 | 它回答什麼 |
|---|---|
| `CLAUDE.md` | 專案硬規範（圖示、時間、色票、套件安裝、版權）——**這些是紅線，不是建議** |
| 這份 | 一套世界要交付什麼、怎麼做、怎麼驗 |
| `DEVPLAN.md` | 架構與功能規格；分區驅動建築的設計在 `### 分區驅動建築` |
| `plan/DEMO_POC_GUIDE.md` | **demo 要長成什麼樣才配叫 POC** —— 必備控制列、四個地形 profile、驗收 |

再給它 `plan/` 下面六個 demo 當範例。它們是單檔 HTML，可以直接讀、直接跑、直接改：

```
plan/paper-town-demo.html        3D 瓦楞紙（建築系評圖模型）
plan/plastic-town-demo.html      3D 積木（玩具箱）
plan/circuit-town-demo.html      3D 電子（單晶片機）
plan/phaser-handdrawn-demo.html  2D 瓦楞紙
plan/phaser-plastic-demo.html    2D 積木
plan/phaser-circuit-demo.html    2D 電子
plan/theme-music-demo-opus.html  三套世界的主題配樂
```

**一句話的建議：不要讓 LLM 直接改 `packages/`。** 先在 `plan/` 做出一套 demo，改到滿意，
再移植。理由見第 2 節。

---

## 1. 一套「世界」要交付什麼

四件事，順序不要顛倒：

1. **3D demo**（Three.js，單檔 HTML）——世界的主體。
2. **2D demo**（Phaser，單檔 HTML）——同一套世界的側視版。歡迎頁背景與 2D 模式共用它。
3. **主題配樂**（Web Audio，程序生成）——樂器要從這個世界的**材質**推導，不是隨便挑一個曲風。
4. **移植**——把 demo 的作法接進 `TerrainStyleStrategy` 與 `PhaserStyleStrategy`。

2D 不是 3D 的縮水版。它是同一套詞彙的**側視剖面**，兩邊的山形、配色、物件必須對得上
（真實遊戲裡 `generateMountainProfile` 與 `generateMountainPoints` 就是為了這件事而成對存在）。

---

## 2. 為什麼一定先做 demo

`packages/web` 的 3D 管線同時要處理 chunk 生命週期、floating origin、DEM 取樣、MVT 解析、
LOD、dispose 所有權。**設計期不該同時扛這些。** demo 是單檔 HTML、零 build、開瀏覽器就看得到，
而且有四個 headless probe 可以在 WSL / CI 裡直接驗（第 9 節）。

實務上的差別：在 demo 裡砍掉重練一個造型是十分鐘的事；在 gameview 裡是半天，而且你會因為捨不得
而留下一個其實不對的設計。**我們的紙牌屋就是這樣被留了太久**——它在 demo 裡就該被換掉。

---

## 3. 設計法則

以下每一條都是實際做壞過才寫下來的。它們比任何「風格描述」都重要。

### 3.1 詞彙量勝過細節

一個世界好不好看，取決於**它有幾種不同的東西**，不是每種東西做得多細。

瓦楞紙世界成立，是因為它有十二種文具（橡皮擦、索引標籤片台、膠帶台、藥盒、算盤、迴紋針、
圖釘、色紙、切割墊……）。積木世界第一版不成立，是因為它只有「積木」——十一種尺寸的積木。

**做法：先列出這個世界的物件詞彙表（15 個以上），再開始建模。** 詞彙表列不出來，代表這個
世界的概念還沒想清楚，這時候寫任何程式碼都是浪費。

### 3.2 手感撞號比輪廓撞號更難察覺

「兩棟房子形狀不一樣」很容易檢查，「兩棟房子摸起來是同一種東西」很難。

積木世界第一版的三種建築裡有兩種都是**硬的、亮面的塑膠**——紙牌屋與抽抽樂塔。輪廓完全不同，
遠看卻只像同一種材質的三個尺寸。換成黏土（霧面、軟）之後才分得開。

**做法：列詞彙表時，每一項後面加註它的材質手感**（硬/軟、亮/霧、厚/薄、實心/半透）。
同一個世界裡手感全撞的，等於沒有那個詞彙。

### 3.3 一個元件只能有一個身分

電子世界的排針既然當了等高線疊層的裙邊，橋梁欄杆就不能再用排針——否則遠看兩處長一樣，
**詞彙量是虛胖的**。欄杆改成銅柱。

### 3.4 眼高法則：騎士眼睛只在地面上 6.3 公尺

chase cam 的高度是 `fps-camera.ts` 的 `CHASE_UP`。這個數字支配了非常多設計：

- **薄片會消失。** 側對騎手的薄片幾乎沒有投影面積。字母積木要排成有厚度的一長排、
  骨牌要排兩排以上、卡片類厚度不得低於 0.3。
- **高於視線的水平面看不到。** 等高線疊層的「踏面」一階一階全部藏在自己的豎邊後面，
  遠看會糊成一面牆。解法是每道切口上緣留一道 **45° 翻邊**（上色時顏料本來就會從踏面翻過
  切口一點點），那道斜面朝內上方、迎光，從下面看得到。
- **遠處的細分是白花的。** 直徑幾個 pixel 的圓柱用 24 段跟用 6 段完全一樣。

### 3.5 鏤空會在天際線開洞

逆光或夜間，鏤空的量體整個消失。**量體一律實心。**

### 3.6 遠近兩圈山：遠的張角必須比近的大

`maxH / radius` 這個比值，遠圈一定要大於近圈，否則遠山整圈躲在近山後面，你白算兩萬個面。
所以近圈做**矮丘陵**、遠圈才做**高山**——這樣兩層都看得到，視差也才有東西可以差。

### 3.7 不要用系統字型

騎乘距離會糊，而且跨機器不一致（Windows / WSL / CI 各長不一樣）。字母、數字一律用幾何線條
自己畫。

### 3.8 材質要從這個世界自己的貨架上拿

積木世界的學校本來想用算盤，不行——算盤是**教具／文具**，那是瓦楞紙世界的貨架。同一個
概念要從玩具箱裡找（最後用了字母積木）。

問自己：「這個東西會跟世界裡其他東西擺在同一個盒子裡嗎？」不會，就換掉。

### 3.9 決定形體的東西，必須同時決定燈

夜間的燈**不是一層可以事後蓋上去的貼花**。真實遊戲的 `collectFacadeWindowPlacements()`
拿建築的包圍盒、用 `width / colSpacing` 切欄、`height / rowSpacing` 切列，在兩個面上蓋一格
小方窗的網格——**它完全不知道自己蓋在什麼東西上**。

分區驅動建築一落地，這就會做出**有窗戶的電解電容**。而且十三種形體會被蓋上同一種小方格，
剛才辛苦做出來的詞彙量瞬間被抹平。

正確的作法是讓每種建築自己宣告燈在哪，而且燈要長在**那個物件本來就有的東西**上：

| 建築 | 它的「窗」 |
|---|---|
| 黏土像素屋 | 第二層的幾格體素**換色**（不是挖洞） |
| 骨牌牆 | 骨牌上的**點** |
| 抽抽樂塔 | 每層交錯 90° 露出來的**方形短面**，隨機亮幾個 |
| 杯塔 | 半透明杯壁**整個**透光（不是杯壁開小窗） |
| 算盤 | 珠子 |
| 藥盒 | 分格的蓋子 |
| 電解電容 / DIP IC / 橡皮擦 | **沒有燈** |

**「這種建築沒有燈」是完全合法的答案，而且比硬加方窗好。** 電容不會發光。

### 3.10 一盞燈要「小、在裡面、被半透明的殼包著」

這一條是三個世界各犯一次才寫下來的。三個世界的路燈原本都是**整個罩子一起發光**：

- 電子世界的 5mm LED——整顆環氧樹脂點亮，夜裡再把 opacity 從 0.55 拉到 0.97。
- 塑膠世界的乒乓球——實心的白球整顆透光。
- 手繪世界的鉛筆——筆尖 emissive 一路推上去。

三個看起來都一樣：**一塊會發光的色塊**，沒有任何一個看得出是燈。

原因是同一個：**發光面積等於物件面積**時，眼睛得不到任何「這裡面有一個光源」的線索。
真的燈之所以看得出來，是因為你看見的是**一個小亮點被一層看得穿的殼包著**——LED 的晶粒
在環氧樹脂裡、燈泡的燈絲在玻璃裡、氣球燈的光源在膜裡。三個條件缺一不可：

1. **小**——亮的東西要遠小於罩子。整片亮 = 色塊。
2. **在裡面**——亮點要有深度，看得出它被包著。
3. **殼要保持半透明**——夜裡**不能**把 opacity 往上推。這是最反直覺的一條：直覺會想
   「亮了就該更實」，但殼一變實就把自己的光源蓋掉了。三個世界夜裡都改成 opacity 略降。

實作上還有兩個一定會踩的坑：

- **半透明的殼要 `depthWrite: false`。** 不關的話它會擋掉自己裡面的亮點，前面三件事白做。
- **有 bloom 的世界，光靠顏色推不過亮部門檻。** 亮部取樣算的是亮度
  `0.2126R + 0.7152G + 0.0722B`，純紅 `#ff3b3b` 的亮度只有 0.28，紅燈和藍燈永遠不會發光，
  只有綠燈會。亮點的顏色要**白 + 色**兩份疊（本專案用 `0.75 白 + 1.35 色`），四個顏色的
  亮度才都落在門檻之上，而 2.1:0.8 的比例仍然一眼看得出是哪一色。**核心白、暈開有色**——
  燈拍起來本來就是這樣。

順帶一提，這一條也順便解決了「路燈是什麼」的詞彙問題：**去找那個本來就是「膜／殼包著空氣」
的日常物件**。透明筆蓋、吹泡泡塑膠、LED 的樹脂頭——它們本來就是燈罩，不必再發明一個。

**最後一件，比上面全部加起來更容易忘：同一種零件只能有一份做法。**
這條法則我們踩了兩次。第一次是把三個世界的路燈修好之後，才發現 2D 那三支還是舊畫法；第二次是
電子世界的 IC 頂上也頂著一顆 LED，跟路燈是同一種零件、卻是另外一段程式碼寫的——路燈換成
「半透明殼 + 裡面的晶粒」之後，那顆還是一坨實心的紅。

**兩份程式碼畫同一種東西，它們遲早會長得不一樣，而且是在你改好其中一份的那一刻。**
做法是把那個零件抽成一支函式（本專案：3D 的 `ledBody(r, lensMat, dieMat)`、2D 的
`drawLedBody()`／`drawLedGlow()`），路燈跟指示燈只是傳不同的半徑與材質。抽完之後它們不可能
再分岔——這比「記得兩邊都要改」可靠得多。

同理適用於 2D／3D 之間：兩邊的**造型語言**必須一致（同一種載體、同一種發光邏輯），即使
實作無法共用。改了 3D 的路燈就去看 2D 的，反之亦然。

### 3.11 顏色不能照抄 2D 的值到 3D

2D 是平塗；3D 還要再乘一次打光、再乘一次 toon 的階梯量化。照抄 2D 的中間調到 3D 會變成一片黑。
**3D 的值要比 2D 高一階。**

---

## 4. 要交付的元件清單

真實遊戲的兩個介面是唯一的權威清單：

- `packages/web/src/game/terrain/terrain-style-strategy.ts` → `TerrainStyleStrategy`（45 個成員）
- `packages/web/src/game/phaser/phaser-style-strategy.ts` → `PhaserStyleStrategy`（37 個成員）

**以程式碼為準，不要以本表為準**（介面會長）。分組如下，方便排優先順序：

| 群組 | 3D（TerrainStyleStrategy） | 先做？ |
|---|---|---|
| 地形 | `createTerrainMaterial` `createTerrainWallMaterial?` `terrainVertexColor` `quantizeElevation` | ✅ 第一個 |
| 道路 | `createRoadMaterial` `roadColor` `roadWidth` `routeLine` | ✅ |
| 建築 | `buildBuildingBody?` `buildBuildingDecoration` `createBuildingMaterial` `buildingColor` `buildingTopColor?` `facadeWindows?` | ✅ |
| 土地分區 | `createUrbanMaterial` `urbanColor` `createParkMaterial` `createForestMaterial` `createWaterMaterial` `createSandMaterial` `createWetlandMaterial` `createFarmlandMaterial` `createSportsFieldMaterial` | 之後 |
| 植被 | `buildTreeGeometry?` `createTreeMaterial` `treeTrunkColor` `treeCanopyColors` `tintTreeInstances` `outlineTrees` | ✅ |
| 遠景／天空 | `generateMountainProfile` `mountainColor` `horizonColor` `skyPalette` | ✅ |
| 道具 | `buildBikeOrnament` `buildStreetLamp` `buildCoinMesh` `buildCheckpoint` `buildFinishAirship` `buildPlaneOrnament` `buildTunnelPortal?` | 之後 |
| 後製 | `createPostPass` `applyPostParams` `createOutline?` | 最後 |
| 即時訊號 | `updateRiderSignals?`（每幀的踏頻／功率——**整組可以不宣告**，見 §4.5） | 之後 |
| 生命週期 | `dispose` `style` `params` | ✅ |

2D 那邊對應的是 `drawTerrainSurface` `renderBuilding` `renderTree` `renderRoadSurface`
`drawMountainSilhouette` `generateMountainPoints` `getSkyColors` `generateCyclistFrame`
`drawCoinTexture` `drawFlag` `drawCloud` `drawMoon` `drawStar` `renderWater` `renderUrban`
`renderGrass` `renderSand` `renderAeroway` `renderWaterway` `renderRoadLamp` 等。

**注意 `buildBuildingBody` 的合約**：回傳的是 box 的**區域座標**、**沒有材質、沒有 transform**
的純幾何——建築 renderer 會自己烘 `rotY`、上頂點色，並且把整個 chunk 的所有建築 **merge 成一份**。
你若在這裡回傳帶材質的 Group，就等於放棄了 merge，一個 chunk 會從 1 個 draw call 變成 200 個。

---

## 4.5 世界可以對哪些即時訊號反應

前面那張表是「世界長什麼樣」。這一節是**「世界對正在騎的人有什麼反應」** —— 一個世界可以
在每一幀讀到哪些活的數字、單位是什麼、多久換一次、以及**哪一個可能根本不存在**。

**gameview 目前只有電子世界用到這一節；三個 POC 已經三個都有了**（2026-07-30）。三種反應
刻意是**不同種類**的，因為「共用機制，不共用造型」在這裡的意思就是三個世界不能是同一種反應
換顏色：

| 世界 | 踏頻 → | 功率 → | 種類 |
|---|---|---|---|
| 電子 | 脈衝沿走線行進的速度 | 接點火花與線身亮度 | 連續、線狀 |
| 積木 | 泡泡冒出的速率 | 泡泡大小 | 離散、顆粒 |
| 瓦楞紙 | 全鎮擺動的拍子 | 筆壓（修正液線寬 + 墨色） | 週期、整體 |

⚠ **積木與瓦楞紙還沒移植進 gameview**，而下面那條斷言正擋著它：
`rider-signals-vs-demo.ts` 有一條要求 `plastic.updateRiderSignals === undefined &&
paper.updateRiderSignals === undefined`。那條今天是對的（gameview 真的還沒有），移植的時候
**要把它反過來**，不是刪掉——它是一張帳，不是一個障礙。

「不宣告」仍然是合法答案：**先問你的世界有沒有這種東西，沒有就整節跳過**，不宣告任何 hook，
幾何與 census 一格都不會動。

### 4.5.1 兩條規矩，先讀

1. **`null` 是一個值，而且它不是 0。** 沒接踏頻感測器不等於 0 rpm。0 rpm 是「這個人停止
   踩了」——那是世界該演出來的事；`null` 是「沒有人知道」——那是世界**不可以**演成停止踩
   的事。所有可能沒有的訊號都是 `T | null`，而且兩者在畫面上必須不一樣。
   內建的示範在 `bike-ornament.ts`：`null` 退回「車輪轉速 × 齒比」（也就是這個參數出現以前
   的行為），`0` 讓曲柄**停住**而車輪照轉。
2. **這條路上不准新增計算。** 每個欄位都是後端已經算好推過來的值，前端只轉手
   （`CLAUDE.md`「前後端職責分工」）。要區間、要平均、要 NP，那是後端的欄位，不是這裡的
   一行程式。`rider-signals-vs-demo.ts` 有一條斷言在數 `riderSignals` 在 renderer 裡出現
   幾次，多一個出現點就會失敗——因為多出來的那一個幾乎一定是在算什麼。

### 4.5.2 到得了 strategy 的即時訊號

**`TerrainStyleStrategy.updateRiderSignals?(signals: RiderSignals, dt): void`**
（`terrain-style-strategy.ts`）——每一幀呼叫一次，宣告了才會被呼叫。

| 欄位 | 型別／單位 | 來源 | 更新頻率 | 可能沒有？ |
|---|---|---|---|---|
| `cadenceRpm` | `number \| null`，rpm | `sensorStore.sc.cadence`，沒有速度／踏頻感測器時退到功率計自己的踏頻通道（`sensorStore.pwr.cadence`） | **感測器事件驅動** —— 每一個 ANT+/BLE 廣播一幀，`live-session.ts` 收到就轉發（mock 是 1 Hz，`mock-sensor.ts`）。它是**階梯訊號**，兩次之間一直保持上一個值 | **會**。兩個都沒回報就是 `null` |
| `powerW` | `number \| null`，W | `gameStateStore.powerW` | 20 Hz（server 的 `game_state` tick），階梯訊號 | **會**。本場第一個 `game_state` 幀到達之前是 `null` |
| `powerSource` | `'meter' \| 'estimated' \| null` | `gameStateStore.powerSource` | 同上 | 同上（跟 `powerW` 同時變成非 null） |
| `dt` | `number`，秒 | 這一幀的時間 | 每幀 | 不會 |

**`powerSource` 是這張表裡最需要看的一格。** `'estimated'` 的瓦數不是量到的，是 server 用
訓練台功率曲線從**輪速**推回來的。拿它去做強烈的視覺反應，畫面會告訴騎士「你踩得比較用力」
而事實只是「你騎得比較快」——那是騙人。電子世界的作法是把 `'estimated'` 跟 `null` 一視同仁
（`wattGain()` 回傳 1，也就是不乘），而那是**建議的讀法**，不是唯一的讀法：想做「估計值的
時候換一種弱一點的表現」也可以，但不能假裝它是量測值。

⚠ **兩個坑：**

- **感測器掉線不會變回 `null`。** client 這一側沒有 staleness timeout（見 `sensorStore.ts`：
  只有 `updateSc` 與 `reset` 會改那個值），所以 `null` 的意思是「**這一場從來沒回報過**」，
  不是「現在沒在回報」。一個掉線的踏頻感測器會讓最後一個讀數一直留在那裡。
- **範圍外的輸入是你的問題。** demo 的滑桿在讀進來的那一步就夾住（踏頻 60–110、功率
  80–320，見它的 `readPedal`），所以 demo 的公式從來沒收到 0 rpm 或 400 rpm。真的感測器
  會給。**不要把 demo 的線往外延伸**：0 rpm 代進電子世界的 `cadenceSpeed` 是 −0.46 uv/秒，
  電流會倒著跑。照抄 demo 自己的夾值。

### 4.5.3 其他也會餵活數字進 strategy 的通道（本來就有的）

`updateRiderSignals` 不是唯一一條。這些是既有的，一併列出來免得有人重造：

| 通道 | 拿到什麼 | 單位／頻率 |
|---|---|---|
| `StreetLampParts.setNight(k)` | 0 = 白天、1 = 深夜 | 每幀，但有 0.005 的門檻（`street-lamp.ts`） |
| `registerNightLitMaterial(mat, glow)` | 不呼叫你，而是**全域一次寫入**把 `mat.emissive` 設成 `glow × k` | 每幀一次寫（`setNightLitFactor`） |
| `nightLitFactor()` | 上面那個 `k` 的**讀取端**，給 `emissive` 帶不動的材質用（電子的火花是加色 `MeshBasicMaterial`，沒有 emissive 可寫） | 讀值，隨時 |
| `RouteBody.refresh(ground, d0, d1)` / `.window(range)` | 騎士走到哪了，以**里程區間**表示 | 串流進一個 chunk 時 / 換 chunk 時 |
| `FinishAirshipParts.update(dt, elapsed)` | 幀時間與總經過秒數 | 每幀 |
| `FinishAirshipParts.setBannerText(text)` | 「剩 N km · M 分」——server 推估的完賽點 | **1 Hz**（`GameView.tickFinishBanner`） |
| `buildCelestialDisc` 的 `userData.beam` / `beamSpeed` | 宣告一張要被捲動的貼圖，sky-and-fog 每幀推它的 `offset.x` | 每幀 |
| `applyPostParams(pass)` | 把 `params` 推進後製 pass | 參數變動時 |

### 4.5.4 **到不了** strategy 的東西（以及那是設計還是待辦）

這半張表跟上面一樣重要。下面每一項都是「遊戲裡有、造型層拿不到」，寫下來是為了不要有人
照著猜的 API 寫程式。

| 訊號 | 現在到哪 | 為什麼到不了 strategy |
|---|---|---|
| **心率／HR 區間** | `updatePhysiology(hrZone, speedKmh)` → 只給 `cycling-glasses-effect`（隧道視野） | **待辦。** 沒有人要求過，加進 `RiderSignals` 是一個欄位的事。要注意的是它跟世界造型的關係比踏頻遠得多——心率是騎士的狀態，不是他對世界做的事 |
| **車速** | `BikeOrnament`（車輪滾動，走 route progress 平滑過的 m/s）與 `updatePhysiology` | **待辦，但先想清楚。** 車速在 3D 這一側有兩個版本（server 的 `speedKmh` 與 renderer 從里程差分平滑出來的），送錯一個會讓車輪與世界不同步 |
| **紅線／連擊／金幣數** | `setDarkened()`（3D 版是**空的**，見 `useTerrainRenderer`）、`triggerCoinGlow()` → 眼鏡特效 | **設計。** 那是遊戲化的回饋，不是這個世界的物理 |
| **天氣、風、閃電** | `setWeather` / `setWind` / `triggerLightning` → sky-and-fog、weather 粒子、壓克力罩 | **設計。** 天氣是**共用機制**（三個世界同一份雨、同一份霧），style 只交「數字」（例如 `AcrylicCaseStyle.tintRain`）。要世界對雨有反應，正確的作法是多一個宣告值，不是把天氣塞進每幀的 hook |
| **暫停／自動暫停** | `gameStateStore.paused` / `autoPaused` → HUD | **待辦。** demo 的斷電開關（`powerOn`）是最接近的東西，而它**刻意沒有被對應到暫停**——那會是發明，不是移植 |
| **幽靈車的位置與差距** | `updateGhost` / `setGhostInfo` → `ghost-rider`（半透明的自己 + 名牌） | **設計。** 幽靈是遊戲功能不是世界造型（`DEMO_POC_GUIDE` §8 已經先裁示過這一條） |
| **2D（Phaser）整條** | 完全沒有。`PhaserStyleStrategy` 唯一的每幀 hook 是 `updateOverlay?(frameCount)`，而它只拿到**幀數**，一個騎士的數字都沒有 | **待辦，形狀已知。** 2D 的路線是 scene 的 `routeLayer` 畫的，不是 strategy 畫的，所以就算把訊號送到也沒有地方接它的主要消費端。`phaser/circuit-style.ts` 檔頭記著這一條 |

### 4.5.5 一個實作範例（電子世界，`circuit-terrain-style.ts`）

```ts
updateRiderSignals: (signals, dt) => {
  // 踏頻 → 電流跑多快。demo animate() 那兩行。
  pulseU = (pulseU - dt * cadenceSpeed(signals.cadenceRpm)) % 1;
  pulseTex.offset.x = pulseU;
  // 功率 → 亮多少。估計值與「沒有」走同一條(wattGain(null) === 1)。
  const wg = wattGain(signals.powerSource === 'meter' ? signals.powerW : null);
  for (const m of dupWireMats) m.emissiveIntensity = wg * DUP_GLOW_PEAK;
  sparkMat().opacity = Math.min(1, wg * (0.34 + 0.5 * nightLitFactor()));
  for (const animate of liveRoutes) animate();
},
```

四件從這段學得到的事：

1. **相位每圈繞回（`% 1`）。** demo 不繞，因為 demo 跑幾分鐘；一趟騎乘是幾小時，累到
   −9700 之後 `offset.x` 上傳成 float32 只剩 ~1e-3 uv 的解析度（256 寬的貼圖上是 0.26 px），
   脈衝會開始一格一格跳。貼圖是 `RepeatWrapping`、相位只讀 `frac()`，所以減整數圈**在數學
   上完全等價** —— 這是修精度，不是改動畫。
2. **不要碰日夜驅動已經在寫的那一格。** 夜燈寫的是 `emissive` 的**顏色**，所以功率乘在
   `emissiveIntensity` 與火花的 `opacity` 上 —— 兩隻手不碰同一格。反過來說，想在這裡調
   `emissive` 顏色的世界會發現它每幀被覆蓋掉，而且看不出是誰。
3. **沒有人餵訊號時要什麼都不畫，而不是畫一個靜止的版本。** 火花那批 instance 的
   `count` 從 0 開始；沒有驅動就是 0 張。「一排常亮的白點」比不畫更錯。
4. **成本要量。** 火花被驅動時是 **+1 draw call / +1 geometry / +1 material**（整條路線一批
   `InstancedMesh`，不是每個接點一個）。⚠ 而 `render-probe` 的 `CENSUS=1` **看不到它**——
   那支 probe 建完場景就光柵化，一幀都不推，所以還沒被驅動的批次不會現身。

   ⚠⚠ **但機制不是「`count = 0` 會被跳過」——那是錯的，2026-07-30 實測。**
   `scene-census.mjs:32` 的 `isShown()` **只看 `visible`**，一個 `count = 0` 的
   `InstancedMesh` 照樣被算一個 draw call（塑膠泡泡在設 `visible` 之前 `?bub=0` 量到
   **253**，設了之後 **252**）。所以想讓「關掉時真的零成本」成立，**必須自己把
   `visible` 設成 false**，光把 `count` 歸零不夠。

   這是第 10 節「probe 會騙你的地方」的一條：**任何靠每幀驅動才現身的東西，census 都
   量不到，要自己在檢查裡量**（`route-body-vs-demo.ts` 有一條就是在做這件事）。

---

## 5. 分區驅動建築

五種土地分區（住宅／商業零售／工業／學校／醫院）各對應一種建築形體。完整設計、對照表、
以及踩過的坑都在 `DEVPLAN.md` 的 `### 分區驅動建築`。做新世界時必讀。

兩件一定會踩到的事：

- **分區取樣一律用 Fisher–Yates 洗牌袋，不要逐段獨立亂數。** 這是三個人各自獨立踩到的坑：
  逐段獨立亂數在 8 公里尺度會嚴重偏斜，你會看到整整兩公里都是住宅。
- **空分區要保底。** 「讀到分區但一棟都沒抽中」跟「這裡本來就是空地」在畫面上**無法區分**，
  但前者是 bug。作法：把路線切成同分區的連續區間，區間內建築數為 0 就在中點強制補一棟該分區
  的主建築。電子世界實測：沒保底時 72 格空 14 格，加上之後 75 格空 0 格。

- **新功能不可以從共用亂數流抽數。** 這條最容易犯，而且症狀離原因很遠。

  電子世界加招牌時，招牌的「抽哪個字」「掛多高」是從 chunk 的共用 `rng` 拿的。看起來無害，
  實際上災難性：建築是照順序蓋的，所以**「這一棟有沒有招牌」會決定下一棟拿到哪個值**——
  光是加上招牌這個功能，整條路線的建築高度、鄰近型別、哪個 chunk 出現地標**全部被重骰**。

  症狀是「夜間發光材質數會隨位置飄 ±1」，追下去才發現是共用流被污染。

  **作法：任何新增的裝飾自己開一條流，種子取自穩定的空間量**（建築在路線上的距離之類）：
  ```js
  const signSeedAt = (d) => (Math.round(d * 16) ^ 0x5ca1e) >>> 0;
  // ...
  const rng = mulberry32(seed);   // 招牌自己的流,不碰 chunk 那條
  ```
  這樣同一個位置永遠長出同一塊招牌，而且**以後再加任何裝飾都不會再動到世界內容**。

  對真實遊戲這不只是整潔問題：路線是 seed 驅動的，同一條路線每次騎應該長得一樣。

---

## 6. 效能預算

真實遊戲跑在 **Intel N100 迷你主機**。已知：**密集市區（台北）是 CPU/RAM 受限**（chunk 建構
風暴），**稀疏路線是 fill-rate 受限**。所以優先序是：

> 貼圖建構成本 ＞ draw call 數 ＞ unique material／geometry 數 ＞ 三角形數

三個 demo 優化前後的實測值，拿來當你的基準線（用第 9 節的工具自己量）：

| | draw calls | unique geo / mat | canvas | 貼圖 pixel-writes |
|---|---|---|---|---|
| 瓦楞紙 3D | 731（0 instancing）→ **244** | 499 / 81 → **70 / 66** | 86 → **36** | 21.0M → **2.4M** |
| 積木 3D | 1010 → **215** | 330 / 185 → **81 / 71** | 3 | ~0 |
| 電子 3D | 1424 → **161** | 80 / 67 → **74 / 69** | 20 → 22 | 1.0M |

（積木的三角形另外從 114k 降到 60k，其中凸點從 164k 面降到 49k。）

三個世界的瓶頸**完全不同**，所以「優化」不是一套通用手法：

- 瓦楞紙的問題是**貼圖建構**（69 張 256×256 的顏料筆觸，每個顏色重刷一整張）→ 共用一張中性
  筆觸貼圖 + `material.color` 染色，加尺寸旋鈕分級（量體 128、小件 64）。
- 積木的問題是**三角形與材質數**（每顆凸點 12 段 × 3400 顆；185 個材質）→ 凸點依 chunk 距離
  分級（8/6/4 邊，同一份 unit geometry 換 `InstancedMesh.geometry` 即可，矩陣不動），材質快取
  改用「顏色 + 序列化的 opts」當 key。
- 電子的問題是**純 draw call 浪費**（1424 次畫 20k 三角形，平均每次 19 個）→ 建築程式碼一行不改，
  在 `buildChunk` 最後跑一次「攤平」：把用共用幾何的 mesh 連同 `matrixWorld` 摘進以
  `(geometry, material, castShadow, receiveShadow, renderOrder)` 為 key 的 InstancedMesh 池。

**先量再改。** 三個世界如果都套同一招，你會在兩個世界上白做工。

建議目標：draw calls ≤ 350、unique material ≤ 70、貼圖 pixel-writes ≤ 6M、canvas ≤ 30。

三個實作各自留下一條可以直接抄的作法：

- **凸點的距離分級**（積木）——三級用的是**同一份** unit geometry，換頁時只重指
  `InstancedMesh.geometry`，instance 矩陣完全不動，所以換級是零成本；而且你正在騎的那個
  chunk 永遠是最高級，不會出現「騎上去才變粗糙」。
- **事後攤平**（電子）——不改任何建模程式碼就能收掉 90% 的 draw call，代價只有一次 traverse。
  跨 chunk 共用池、換頁只重寫矩陣不重建 buffer。
- **共用筆觸 + 染色**（瓦楞紙）——但顏料要刷**淺灰不是純白**：刷白底的話 `tint` 往亮的那半邊
  沒有空間走，整張會平掉、筆觸全丟。而且共用之後「刷不滿露出底板」那一階會不見，要把底板色
  依 coverage 摻回去（實測 20%），並除掉筆觸貼圖自己的平均亮度。

### dispose 的所有權規則（這條錯了會很難查）

- `createBuildingMaterial()` 回傳的是 **strategy 擁有的 singleton**，renderer **不可以** dispose。
- 其他 `create*Material()` 每次回傳新實例，由建立該 mesh 的 renderer 負責 dispose。
- `buildBuildingDecoration` 用到的材質必須標 `material.userData.shared = true`，chunk 回收器才會放過它。
- **共用的 geometry / material 絕對不可以在 chunk 回收時 dispose**——你會把還在用的別的 chunk 弄掛。
- `InstancedMesh` 也要 dispose，而且很容易漏。demo 裡有這段 sweep 可以抄：
  ```js
  group.traverse((o) => { if (o.isInstancedMesh) disposables.push(o); });
  ```

---

## 7. 程序性貼圖的規矩

### 7.1 無縫

會 repeat 的貼圖，接縫是最容易犯也最容易被忽略的錯（在單張圖上完全看不出來）。

- 波形要用**整數波數**：`Math.sin((x / W) * Math.PI * 2 * waves + ph)`，`waves` 取整數。
- 步進要能**整除畫布寬度**。`x += 10` 在 256 寬的畫布上會留 6px 的縫，於是每一塊 tile 之間
  出現一條豎線。改用「切幾段」而不是「每次走幾格」：
  ```js
  const SEG = 26;
  for (let k = 0; k <= SEG; k++) { const x = (k / SEG) * W; /* ... */ }
  ```
- 點狀元素要用九宮格包裹（`wrap9()`）——**而且 `rng()` 必須在 callback 外面呼叫**，
  不然你得到的是九個不同的點，不是同一個點的九份複製。
- 圓周方向的 uv，一圈總長要**取整**，否則繞回 0 的那一格會被壓扁成一條從山腳劃到山頂的接縫。
  位置用 `i+1`（cos/sin 本來就週期），只有查表才取模。

**驗收方式：用 texture-probe 產出的 `tile-NN.png`（2×2 拼接）看，不要看 `tex-NN.png`。**

### 7.2 雙態材質必須共用

如果你的世界有模式切換（例如瓦楞紙的「素紙板 ↔ 廣告顏料」），**所有雙態材質都必須是
chunk 之間共用的實例**。不然切換時只有現存的 chunk 會變，新蓋的 chunk 停在舊模式。
demo 裡的作法是統一走一個 `swappable(mat, plain, painted)` 註冊函式。

### 7.3 顏色住在哪裡

決定「顏色由頂點色帶、還是畫在貼圖裡」之前，先確認該材質**有沒有在吃 vertexColors**。

實例：等高線疊層的切口，頂點色是**灰階的受光量** `[sh, sh, sh]`，分層色根本進不來——
所以遠近兩圈山的墨色必須各畫一張貼圖，不能靠同一張貼圖乘不同的 `material.color`
（乘出來深色的墨線會被拖得更黑，遠山的線反而比近山重）。

---

## 8. 主題配樂

配樂是程序生成的（`plan/theme-music-demo-opus.html`，真實遊戲在
`packages/web/src/game/audio/generative-bgm.ts`）。每個世界回傳
`{ bpm, beatsPerBar, bars, notes[] }`，`note = { t, dur, midi, vel, voice }`。

### 8.1 樂器從世界的材質推導

不要先選曲風再配樂器，要**先問這個世界裡有什麼東西會發出聲音**：

- 玩具箱 → 音樂盒滾筒、玩具鋼琴、木魚、橡皮筋。**每個音都短**——塑膠不延音，
  一有長音整首就變成別的世界。
- 工作檯 → 氈槌鋼琴、紙的摩擦、鉛筆刮擦、板材落桌、尺彈桌邊。**打擊全部是噪音源，
  一點金屬都沒有**：這個世界裡沒有金屬做的東西。
- 電路板 → 方波／三角波、繼電器、市電哼聲、線圈嘯叫。繼電器要**兩段極短的爆音**
  （吸合 + 撞到鐵芯，中間差 6 ms），只有一段的話聽起來就只是個 click。

### 8.2 三條會讓曲子「聽不出來」的錯

這三個都是實際發生過、而且**使用者聽得出來但講不出原因**的：

**（1）沒有動機，就沒有曲子。**
隨機遊走的旋律（`d += pick([-2,-1,1,1,2])`）跟純琶音（`arp[i % 8]` 重複）都**不是旋律**，
它們是織體。聽的人抓不到任何可以記住的東西，於是「聽不太出來」。

做法：抽一個 3–4 音的**細胞**，整首靠它變形（B 段整組上移三度、樂句最後收在主音）。
一個世界的主題能不能被哼出來，幾乎完全取決於有沒有這個細胞。

**（2）旋律聲部的音量必須壓過低音聲部。**
實際音量 = `note.vel × voice 內部的增益係數`。這兩個數字分散在兩個地方，很容易各自看起來
合理、乘起來完全錯。電子世界曾經是：

```
方波旋律  vel 0.42 × 增益 0.16 = 0.067
三角波低音 vel 0.70 × 增益 0.32 = 0.224   ← 低音是旋律的 3.3 倍
```

chiptune 的招牌旋律被自己的貝斯整個蓋掉。修正後旋律 0.24 / 低音 0.14。

**做法：把每個聲部的「vel × 增益」實際算出來排一張表**，不要分開看。低於 0.05 的聲部
等於不存在（曾經有一個 pad 是 0.013）。

**（3）不要在開頭跟中段留洞。**
把每小節的音符數印出來。電子世界曾經是：

```
8 9 | 37 37 36 37 36 35 35 37 | 6 6 | 36 34 35 36
└ 開頭 3.4 秒只有掃描音      └ 中間又靜音 3.4 秒
```

前奏要短（1 小節就夠），breakdown 段要**保留旋律**（變成有主題的收束，而不是斷電）。

### 8.3 三個世界的實測值，當你的基準

| | 音符密度 | 旋律聲部實際音量 | 低音 | 動機 |
|---|---|---|---|---|
| 積木 132bpm 2/4 | 17.5/s | musicbox 0.19–0.29 | 0.25–0.32 | 4 音細胞 |
| 紙板 92bpm 3/4 | 4.5/s | ruler 0.14–0.25 | felt 0.09–0.15 | 3 音細胞 |
| 電子 140bpm 4/4 | 18.0/s | square 0.24 | tri 0.14 | 4 音細胞 |

密度差 4 倍是**性格**（工作檯就該留白），旋律音量落在同一個帶則是**必要條件**。

### 8.4 驗收

```bash
node scripts/headless-check/music-probe.mjs plan/theme-music-demo-opus.html
```

它 stub 掉 Web Audio、跑完所有作曲器、把每個音符都送進**真的 voice 程式碼**，檢查：
NaN 進 AudioParam、未知 voice、負的 dur/t、死小節、seed 是否可重現、以及
**`exponentialRampToValueAtTime` 的目標值 ≤ 0**（真的 AudioContext 會丟例外，而且只有時候丟）。

它驗不了好不好聽。上面 8.2 的三件事要自己算，probe 不會告訴你。

---

## 9. 驗收工具

`scripts/headless-check/` 全部純 JS、可在 WSL 裡跑（`packages/` 的 native module 不能在
WSL 用，但這些可以）。分兩類，**用途完全不同**：

### 9.0 先講最重要的那一支：`check:3d`

```bash
npm run check:3d          # scripts/headless-check/diorama.ts
```

下面的 probe 都是**畫給人看**的（然後你要真的把 PNG 打開）。`check:3d` 是**斷言**：
它把 demo 的函式從 HTML 切出來執行，跟 gameview 的實作逐件比對，不通過就 exit 1。
2026-07-28 有 1200 條以上（它會一直長；看 ✓ 的數字有沒有變少，別記死一個數）。
**這才是「移植沒走樣」的證據**，probe 不是。

- 新增獨立的 `*-vs-demo.ts` 要在 `diorama.ts` 的 `STANDALONE_CHECKS` 加一行；
  漏加會被旁邊的守門斷言抓到。
- canvas stub 走共用的 `recording-canvas.ts`（`installRecordingCanvas()`），
  **不要自己裝 `globalThis.document`** —— 貼圖快取是模組層的，六份各自為政的 stub
  讓兩次假通過靜悄悄地過了關。
- **一條沒有人看過它失敗的斷言不是斷言。** 每條新斷言都要突變一次看著它失敗。

### 9.1 畫給人看的 probe

```bash
# 3D：把 demo 的 scene 抓出來，用 CPU z-buffer 光柵化成 PNG
node scripts/headless-check/demo-probe.mjs plan/<x>-demo.html out.png --democam
  STRICT=1      2D context 有任何 NaN / undefined / 壞顏色就失敗
  QS=?night=1   丟給 demo 的 query string（?rain=1 ?paint=0 ?d=1400 ?cam=orbit&r=150 …）
  STEP_MS/FRAMES  時間推進（soak：STEP_MS=50 FRAMES=4000）
  MATDUMP=1     列出所有材質（驗發光集合用）
  CENSUS=1      draw call / geometry / material / 最重的 draw call 排行
  --focus <name> [--dist n]  只框一個道具（給它 .name，probe 找離相機最近的那一個）
    小道具用 --democam 看不出對錯 —— 一盞路燈在跟隨鏡頭裡只有四十個像素高，
    每個剪影都長一樣。要判斷「認不認得出這是什麼」只能拉近了看。
    ⚠ 世界若會把 chunk 攤平成 InstancedMesh 池，道具的 mesh 會被搬走、group 只剩
      下燈，包圍盒因此是空的（probe 會退回用 group 原點 + --focusy）。

# 2D：把 Phaser 整個 stub 掉再光柵化
node scripts/headless-check/phaser-probe.mjs plan/<x>-demo.html out.png --frames 400
  DIST=3000  NIGHT=1  POWER=0

# 2D（真實遊戲，不是 demo）：把 packages/web/src/game/phaser/*-style.ts 的策略方法
# 逐一畫成一張帶標籤的網格 PNG
STYLE=plastic WHAT=building node --no-warnings \
  --import ./scripts/headless-check/register.mjs \
  scripts/headless-check/phaser-style-probe.mjs
  STYLE=plastic|cuphead   WHAT=building|tree|lamp|cloud|flag
  SIZES=15x19,40x84   ZONES=school,null   SEED=0   OUT_DIR=…
  → WHAT=building 把六個分區 × 五種尺寸排成一張圖，一眼看完整套詞彙
  → 每格印出 draw command 數（prims 用 phaser-probe 的計法，
    `plastic-style.ts` 註解裡那組 21→205 就是這個數字）與「畫出來的範圍 vs 名目 box」
  ⚠ 只有白天那層。夜間加光層歸 terrain-builder，策略拿不到（見 plan §3.2）

# 貼圖：用真的（小型）2D 光柵器跑 demo 自己的貼圖程式碼
node scripts/headless-check/texture-probe.mjs plan/<x>-demo.html outdir/
  ONLY=4,83  NOTILE=1  GRID=4 GRIDID=4（稽核走線是否落格、是否只有 45/90 度）
  ⚠ GRID 一定要配 GRIDID。不限定的話，它會拿「只有 PCB 走線該遵守的規則」去量
    檔案裡每一條折線 —— 電子世界的防靜電袋長出手繪折痕的那一刻，就冒出 726 個
    「錯誤」，而那些折痕本來就該是歪的。把尺對準它要量的東西。
  → 每張貼圖產出 tex-（原圖）、tile-（2×2 看接縫）、zoom-（放大看細節）
  → 並列出每張 canvas 的建構成本，依 pixel-writes 排序

# 配樂：stub Web Audio，驗證所有作曲器
node scripts/headless-check/music-probe.mjs plan/theme-music-demo-opus.html

# 真實遊戲的一整段路線：抓真的 MVT 圖磚 + DEM（執行時抓，不存），量建置時間與 census
CENSUS=1 STYLE=circuit node --no-warnings \
  --import ./scripts/headless-check/register.mjs scripts/headless-check/render-probe.ts

# 單一道具拉近看（真實遊戲的 strategy，不是 demo）
PROP=coin STYLE=plastic node --no-warnings \
  --import ./scripts/headless-check/register.mjs scripts/headless-check/prop-preview.ts
  PROP=coin|checkpoint|bike|tree
```

`npm run probe:demo` / `npm run probe:phaser` 是前兩者的捷徑。

### 每個工具能證明什麼、**不能**證明什麼

| 工具 | 能證明 | **不能**證明 |
|---|---|---|
| demo-probe | 幾何在不在、位置對不對、材質參數、draw call 數、沒有 NaN | **貼圖長什麼樣**（貼圖被代換成面積加權主色）、真實 GPU 行為、後製效果 |
| phaser-probe | 2D 物件的螢幕位置、視差、入場動畫時序 | 真實 Phaser 的混色模式、shader |
| phaser-style-probe | **真實遊戲**策略的造型、每格 draw command 數、實際畫出的範圍 vs 名目 box | 夜間外觀（策略只拿得到白天層）、混色模式、描邊接合與圓角、文字 |
| texture-probe | 貼圖的實際畫面、接縫、建構成本、走線落格 | 漸層與文字（被接受但略過，出來會是空白——這是工具的限制，不是發現） |
| music-probe | NaN 進 AudioParam、未知 voice、死小節、seed 可重現、exponential ramp 歸零 | 好不好聽 |

---

## 10. probe 會騙你的地方

**這一節請你的 LLM 一定要讀。** 以下四個都是真實發生過的：probe 給了綠燈，畫面其實是壞的。

1. **`InstancedMesh` 曾被整個跳過** → 積木世界所有凸點在 probe 裡都是隱形的，probe 說「一切正常」。
2. **半透明曾被當成二元判斷**（`opacity < 0.5` 就丟掉，否則當全不透明）→ 每一個 0.6 alpha 的分區
   標示都被畫成全飽和。
3. **貼圖代換值取「第一個滿版填色」** → 瓦楞紙世界的第一個填色是紙的底色，於是**整個世界都被
   render 成板子的土黃色**，而幾何完全正確。現在改成面積加權的主色。
4. **Phaser 的 `setScrollFactor(x, y)` 曾被收成單一值，而且螢幕原點用了相機中心而非 `camera.scroll`**
   → 視差山會滑出畫面或沉到地形後面。

**下面這幾條要自己小心**（5–8 還沒補；9 已經修好了，留著是因為它騙過人很久，而且它
**還有一半是假的**）：

5. **繞序反轉在 demo-probe 裡看不出來。** 這個光柵器不做背面剔除，所以繞反的幾何在 PNG 裡
   完全正常，到瀏覽器就變成黑殼或整個消失（WebGL 預設 `FrontSide`）。一份手工幾何曾經整個
   繞反，是靠圖差**運氣**發現的。現在有 `WINDING=1` 可以驗，但要知道它的判準：
   - 比對的是「面法向 vs 三個頂點法向的平均」，門檻 −0.3。**不能用 `< 0`** —— 平滑著色的
     頂點法向是相鄰面的平均，掃掠管在急彎處本來就會偏離自己的面超過 90°，用 `< 0` 會把
     場景裡每一道摺線都報成 bug。
   - 依**比例**分兩類：整份幾何繞反（100%）才是 bug；零星幾面是自我穿插（路線發光管在急
     轉彎處會折進自己裡面，三個世界都有，屬既有行為）。
   - 加任何稽核都要做**反向對照**：拿一份正確的幾何故意把索引反轉，確認它真的抓得到
     （`0/12 → 12/12`）。永遠回報 clean 的檢查等於沒有檢查。

6. **貼圖替身色不理解「後面畫的蓋住前面畫的」，而且只認得 `fillRect` 跟 `stroke`。**
   - 面積加權會把被完全覆蓋掉的底色一起算進去。「先鋪滿阻焊、再開一個金色的窗」跟
     「先鋪滿金、再壓兩道阻焊邊」在瀏覽器裡一模一樣，在 probe 裡卻是綠色 vs 金色。
   - 用 `fill()` 畫路徑、或用 `drawImage()` 疊圖層的貼圖**完全沒有被統計**，替身色會退回去
     拿背景的 `fillRect`。剪紙樹就是這樣：實際貼圖是綠冠+褐幹的松樹，3D probe 卻畫成一張
     深褐色的卡。

   **所以 3D probe 的顏色只是提示，不是事實。** 顏色一律以 texture-probe 的實圖為準；
   demo-probe 只回答「形體對不對」。曾經整個瓦楞紙世界在 probe 裡是一片土黃，而真實畫面
   是彩色的 —— 幾何全對，顏色全錯。

7. **demo-probe 的著色是 `material.color × 頂點色 × lambert`，就這樣。** 兩個後果：
   - **`emissive` 完全不參與。** 所有「材質自己發光」的夜燈在 probe 圖上**一盞都看不到**。
     驗夜燈要用 `MATDUMP=1` 比對材質層級（夜 N 個 / 日 M 個 / 斷電 K 個），不要看圖。
   - **貼圖的 per-texel alpha 讀不到**，它拿整個 `material.opacity` 當全片的 alpha。所以
     一個「靠貼圖把 alpha 收到 0」的漸層邊緣，在 probe 圖上會出現一條**真實 WebGL 裡不存在
     的硬邊**。看到硬邊先去 texture-probe 確認那張貼圖的 alpha，不要急著「修」。

8. **後製管線在 headless 完全沒被執行。** probe 把 `WebGLRenderer` 整個換掉，
   `renderer.render()` 只是把 scene 存起來。任何 bloom / post pass 都是**零覆蓋**的程式碼。
   這正是為什麼手刻 bloom 的第一條規則是保留 `renderer.render(scene, camera)` 的退路，
   以及為什麼「有 bloom vs 沒 bloom 的夜間亮度」**只能在真的瀏覽器上比**。

9. **probe 的太陽曾經是釘死的常數，而且它從來不看場景裡的燈。**
   `demo-probe.mjs` 的打光整整一段時間是

   ```js
   const sun = new THREE.Vector3(150, 190, 90).normalize();   // demo 舊的那顆太陽
   let lam = 0.42 + 0.58 * Math.max(0, na.dot(sun));
   ```

   ——一個常數方向、一個常數強度。天相滑桿（`?sky`，`dc7c043`）落地之後，主光會從
   正午 +47° 掃到日出 0°（那裡 `skyKeyGain` 把它整個收成 0）再到午夜的月亮，環境光與半
   球光也跟著換值，而**七個相位拍出來是同一張圖**。實測（塑膠世界，只算非背景像素的
   平均亮度）：

   | | 午夜 `?sky=0` | 日出 `?sky=0.25` | 正午 `?sky=0.5` |
   |---|---|---|---|
   | 釘死的太陽 | 97.06 | 100.59 | 102.77 |
   | 讀場景的燈 | **81.89** | **85.88** | 102.76 |

   釘死版的全距是 5.7 階（5.5%），而且那 5.7 階**還不是打光**——它來自太陽/月亮圓片與
   星星那幾個 `MeshBasicMaterial` 的 opacity。改成讀場景之後全距 20.9 階（20.3%）。
   方向更誇張：午夜 vs `?sky=0.15`（同強度、差 22° 仰角）在釘死版只有 0.28% 的像素不同
   （＝場景自己的抖動，也就是**同一張圖**），改完之後是 38.5%。

   「我看了 PNG，打光沒問題」在這段期間**一句都不能信**。現在的做法是：方向 =
   `light.position − light.target.position`（世界座標），強度 = 那盞燈自己的 `intensity`，
   fill = 場景裡 Ambient + Hemisphere 的總和；場景裡一盞平行光都沒有才退回那個常數。

   踩過的兩個坑，接手的人會再踩一次：

   - **「主光強度是 0」是答案，不是「沒有主光」。** 日出與日落那兩個相位 `skyKeyGain`
     刻意把主光收成 0（demo：「平行地面的光照不亮地面」），第一版把 `intensity === 0`
     當成「找不到燈」而退回常數，等於在**最不該有太陽的那兩個相位**塞回一顆滿強度的
     47° 太陽。
   - **toon 量化的是漫射斜坡，不是最後那個像素。** 舊的四階是寫在 `0.42 + 0.58x` 上的
     門檻，夜裡整個範圍只有 0.23–0.43，於是**每一片 toon 表面都掉進第一階**，比真值還亮
     ——夜色被量化吃掉。要量化 `dotNL`（three 的 gradientMap 就是拿它當索引），四階換算
     回 x 之後正午那張圖一個位元組都不會變。

   **還是假的部分**：`PointLight` 一盞都沒有參與。路燈、以及現在球場／遊樂場**唯一的**
   夜間照明都是 PointLight，所以「那盞燈把球場照亮了沒有」這件事 demo-probe **答不了**，
   跟 `emissive`（第 7 條）同一個等級。要驗只能看材質層級與 `light.intensity/visible`，
   或者真的開瀏覽器。

10. **`render-probe` 的 `CENSUS=1` 量不到「只有動起來才存在」的東西。** 它建完場景就
    光柵化，**一幀都不推**（整支檔案裡沒有任何 `dt`、沒有夜間寫入、沒有
    `updateRiderSignals`），而 `scene-census.mjs` 的 `isShown()` 會跳過 `visible === false`
    的物件。所以電子世界的接點火花——一批 `count = 0 / visible = false` 起步、靠每幀驅動
    才現身的 `InstancedMesh`——在 census 上是**完全不存在**的，三個世界的數字「一格都沒
    動」，而真的騎乘中它是多一個 draw call。同一件事也讓所有夜間表現在 census 上都停在
    白天。**靠每幀驅動的東西要在檢查裡自己量**（`route-body-vs-demo.ts` 的「火花的帳面
    成本」那一條就是這樣做的：同一份路線，餵訊號前後各 census 一次）。

**結論：**

- **綠燈不等於對。** 一定要用 Read 工具**真的把 PNG 看過**。
- 幾何看 demo-probe，**貼圖看 texture-probe**——兩者不能互相代替。
- probe 本身也是程式碼，也會有 bug。畫面跟 probe 講的不一樣時，**先懷疑 probe**。
- 「130 通過、1 失敗」有可能是**在第一個 throw 就中斷**的截斷結果，後面 70 個斷言根本沒跑到。
  看 ✓ 的數量，不要只看 ✗。

---

## 11. 移植到 gameview

### 10.1 命名不一致（先知道，免得找半天）

同一套世界在不同地方叫不同名字，這是歷史包袱：

```ts
type WorldStyle   = 'plastic' | 'cuphead' | 'circuit'   // 使用者可見的世界（world-options.ts）
type PhaserStyle  = 'plastic' | 'cuphead' | 'circuit'   // 2D
type TerrainStyle = 'plastic' | 'paper'   | 'circuit'   // 3D ← cuphead 在這裡叫 paper
```

`terrainStyleFromWorldStyle()` 以前是 `world === 'cuphead' ? 'paper' : 'plastic'`，
**第三套世界會靜默變成積木**。移植電子世界時已經改成窮舉的 switch + `never` 檢查，
所以現在漏掉一個世界是編譯錯誤。第四套世界進來時它會直接擋你 —— 那是它的用途。

### 10.2 最大的陷阱：二選一分支

形如 `style === 'cuphead' ? A : B` 的分支對兩套世界是正確的，對第三套會**靜默走進
else**——不會報錯、不會警告，你的世界就是長得像積木。

移植電子世界那一輪把核心的幾處改成窮舉（switch + `never`），**剩下 4 個檔案**：

```
components/welcome/MarkdownView.vue     亮/暗主題判斷
game/phaser/phaser2d-scene.ts
game/terrain/terrain-style-strategy.ts
shared/src/world-options.ts
```

隨時可以重數：

```bash
grep -rn "=== 'cuphead' ?" packages/web/src packages/shared/src
```

（原本是 9 處。`generative-bgm.ts` 的兩處——留聲機 bus 路由與黑膠雜訊——在移植
`plan/theme-music-demo-opus.html` 的三首主題曲時整個消失了：opus 版每個世界都
直接進 master，沒有 per-world 輸出鏈，電子的底噪走的是 `world !== 'circuit'`
這種**針對自己**的判斷而不是二選一。這是「換掉編曲順便把陷阱一起拆掉」的例子。）

**移植第一步就是把剩下的全部改成窮舉**（switch + `never` 檢查，讓漏掉的變成編譯錯誤），
再開始寫你的 strategy。

### 10.3 要碰的檔案

`'cuphead'` 出現在 **31 個原始碼檔案**裡。核心的是：

```
shared/src/config.ts                          設定檔的 style 列舉
web/src/game/terrain/terrain-style-strategy.ts  型別 + 工廠
web/src/game/phaser/phaser-style-strategy.ts    型別 + 工廠
web/src/game/audio/generative-bgm.ts            BGM
web/src/styles/themes.scss                      色票（唯一來源）
web/src/App.vue                                 [data-world-style] 的語意 token
+ 新增 web/src/game/terrain/<你的世界>-terrain-style.ts
+ 新增 web/src/game/phaser/<你的世界>-style.ts
```

其餘多半是 UI 的標籤與判斷。

### 10.4 色票只能有一個來源

`packages/web/src/styles/themes.scss` 是唯一來源。SCSS map 定義色票，mixin 自動吐出全域
CSS 變數，每個顏色兩個 token（實色 `--xx-*` 與 `r, g, b` 三元組 `--xx-*-rgb`）。

- **禁止在元件 CSS 裡寫死主題 hex／rgba。**
- SCSS map 的 key 必須加引號（`'pink':`），裸字會被 sass 當成 CSS 顏色值而觸發警告。
- **已知例外**（canvas / JS 繪製吃不到 CSS var）：`HudChart.vue`、`WorkoutElevationPreview.vue`
  的 JS 調色盤、`game/phaser/*-style.ts` 的貼圖色是**鏡像值**，改 `themes.scss` 時要手動同步
  （檔案裡有註解標示）。
- 陷阱：某些世界的 `--hud-bg` 是暗色，壓在淺色紙卡上會變髒灰。淺色世界的面板底色請用該世界
  自己的紙色 token 或 transparent。

---

## 12. 版權（這是紅線）

- **所有外部資料源**（圖資、地形/高程、天氣）都必須確認版權**與使用政策**（不只授權條款，
  也包含 tile usage policy、商用限制）。新增或更換任何來源前，**先確認、先告知專案擁有者、
  取得確認後才可繼續**——LLM 不可自行決定接入。
- 底圖一律走 **OpenFreeMap**；**禁止**直連 `tile.openstreetmap.org`（違反其 Tile Usage Policy）。
- **不可以把圖磚或它的衍生資料存進 repo。** 這包含解析出來的 footprint 座標與 DEM 高程磚
  —— 執行時抓、用完就丟是一回事，簽進版控並隨專案散布是另一回事。
  （目前 repo 裡沒有任何圖磚：`tile-cache-sw.js` 是瀏覽器自己的 Cache Storage、LRU 淘汰、
  使用者本機；probe 是執行時抓、記憶體裡用完就丟。維持這個狀態。）
- **統計數字不是資料。**「794 個 footprint 裡有 512 個 `height = 0`」「中位 17.0 × 33.0 m」
  是量測結果，可以寫進文件、可以拿來寫合成產生器。做法見 `plan/DEMO_POC_GUIDE.md` §4。
- 目前確認乾淨的來源清單見 `DEVPLAN.md`「外部資料源與版權」；署名字串集中在
  `packages/shared/src/attributions.ts`。
- **造型的版權**：一律取**通用玩法／通用封裝外型**，不印廠牌字樣、料號、商標或包裝圖騰。
  疊紙牌屋、抽取式積木塔、骨牌、字母積木、算盤、JEDEC 封裝外型都是公共領域或通用形制。
  **具體角色的人形剪影有權利人，不要用。**
- **醫院不要用白底紅十字。** 那是日內瓦公約與各國國內法保護的標誌，不是通用符號。
  用紅色三角形，辨識度足夠且沒有這個問題。
- 「像 X 的風格」與「抄 X」之間有距離，而且對方的法務通常比你強。取**類型**（發光輪圈、
  1930 年代橡膠管動畫、單晶片機），不要取**作品**。

---

## 13. 交付前檢查清單

**設計**
- [ ] 物件詞彙表列滿 15 項以上，每項標註了材質手感
- [ ] 沒有兩項手感撞號；沒有一個元件身兼兩個身分
- [ ] 薄片有厚度、量體無鏤空、遠圈山的張角大於近圈
- [ ] 沒有用系統字型
- [ ] 會發光的東西是「小亮點 + 半透明的殼」，殼夜裡沒有變得更不透明，而且 `depthWrite: false`

**功能**
- [ ] 五種土地分區各有對應建築，分區用洗牌袋取樣
- [ ] 空分區有保底，且有量化證明（N 格空 → 0 格空）
- [ ] 日／夜（以及世界自己的模式切換）都正確，雙態材質是共用實例

**POC 能力**（完整版見 `plan/DEMO_POC_GUIDE.md` §3）
- [ ] demo 有那條控制列：地形選單 / 密度 / 太陽（仰角＋方位）/ 假接縫 / 世界抬升
- [ ] 四個地形 profile（`taipei` `pass` `coast` `junction`）都跑得起來
- [ ] 三個 demo 的控制列與 profile 參數表**逐字相同**
- [ ] 沒有任何外部資料被存進 repo —— 分佈是統計數字生的

**效能**
- [ ] `CENSUS=1` 量過：draw calls ≤ 350、unique material ≤ 70
- [ ] texture-probe 量過：canvas ≤ 30、pixel-writes ≤ 6M
- [ ] dispose 所有權正確，共用資源不會被 chunk 回收器 dispose

**驗收**
- [ ] `npm run check:3d` 全過，而且新的 `*-vs-demo.ts` 已註冊進 `STANDALONE_CHECKS`
- [ ] **每一條新斷言都被突變測試看著失敗過一次**（改前後 sha 不同、檢查真的失敗、
      還原後逐位元組相同）
- [ ] `STRICT=1` + soak（`STEP_MS=50 FRAMES=4000 QS="?rain=1&night=1"`）→ `2D context: clean`
- [ ] 2D：多個里程 × 日夜 × 多個入場時點都不拋例外
- [ ] 配樂：music-probe 全綠，而且**每個聲部的「vel × 增益」算過**——旋律必須壓過低音，
      沒有低於 0.05 的聲部，每小節音符數沒有洞
- [ ] **實際看過 PNG**——幾何看 demo-probe、貼圖看 texture-probe 的 `tile-` 版本

**規範**
- [ ] 圖示全部 Font Awesome，沒有 emoji（Ink 終端 UI 不受此限）
- [ ] 時間全部是毫秒 timestamp，格式化一律用 dayjs
- [ ] 顏色全部來自 `themes.scss`，元件 CSS 沒有寫死 hex
- [ ] 外部資料源已確認版權並取得同意
- [ ] 行末維持各檔案原本的樣子（此 repo 各檔案 CRLF/LF 不一致，且沒有 `.gitattributes` 正規化——
      編輯前先 `file <path>` 確認）

---

## 附註：給 LLM 的工作方式建議

- **不要一次改一整個美學。** 使用者說「補上新增的物件」時，就只補物件。我們有一次把 2D 手繪
  世界整個改成積木風，結果只能從 git 復原。**擴充詞彙 ≠ 換掉語彙。**
- **「已實作」和「已定案」要分開記。** 討論定案的東西不會自己變成程式碼。曾經有一項
  （純銅散熱鰭片）在清單上寫著「已定案」，實際上一輪都沒做。落地前以程式碼為準。
- **「記錄了」不等於「送得到」。** 陰影那次量到三個 demo 的 `normalBias` 不一致，
  檢查把那個**分歧**斷言下來了，而三個世界照樣全拿多數決那個值 —— 因為沒有任何東西
  把逐世界的值送到光上。斷言了一個事實，不代表那個事實有生效。
- **平行開多個 agent 時，禁止任何 git 操作。** 一個 agent 的 `git stash` 掃掉過 13 個檔案的
  同時進行工作。每個實作 agent 的指令裡都要明講禁止 stash / checkout / reset。
- **不要自己跑 `npm install`。** 這個專案的 `node_modules` 是 Windows 裝的，WSL 與 Windows 的
  native module 不相容。需要套件請告知使用者。
