import { BookOpen, Clock, Cpu, Layers, Scale, ShieldCheck, Swords, Timer } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FACTOR_LABELS } from '../options';
import { TAIFEX_TECH_FACTOR_KEYS, TAIFEX_TECH_RULES, TECH_FACTOR_LABELS } from '../tech';
import { TAIFEX_FACTOR_KEYS, TAIFEX_FACTOR_WEIGHTS, TAIFEX_RULES } from '../types';
import { PaperDisclaimer } from './taifex-parts';

/** 使用說明（與 docs/TAIFEX_PAPER_TRADING_PLAN.md、docs/USER_GUIDE.md 一起更新） */
export function TaifexGuide() {
  return (
    <div className="space-y-4 text-sm">
      <Section icon={BookOpen} title="這是什麼">
        <p>以台指期近月連續日 K 為基礎的<strong>日線波段策略</strong>虛擬帳戶。每天收盤後計算訊號，隔天開盤以虛擬單成交，所有成本（手續費、滑價、期交稅、換月）都計入。目的是在接券商之前，先用至少 3 個月的紙上紀錄驗證策略。</p>
        <PaperDisclaimer />
      </Section>

      <Section icon={Clock} title="每日流程">
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li><strong className="text-foreground">07:30 / 17:00</strong> Claude 排程推送輿情與事件行事曆（選用）。</li>
          <li><strong className="text-foreground">08:00</strong> 補跑前一天（若 18:00 失敗）→ 盤前檢查：今天有重大事件，或輿情與進場方向強烈相反 → 取消「新開倉 / 反手 / 加碼」的待成交單（平倉單不擋）→ 推播今日下單建議。</li>
          <li><strong className="text-foreground">08:45–13:45</strong> 每 5 分鐘盤中模擬：待成交單以開盤價成交、盤中觸發停損、接近停損提醒；盤中下的手動單以即時價成交。</li>
          <li><strong className="text-foreground">08:45–13:45、15:00–隔日 05:00</strong> 盤中技術模擬（見下方），日盤與夜盤都跑。</li>
          <li><strong className="text-foreground">休市</strong> 週末、證交所公告的休市日、自訂休市日，以及報價超過 45 分鐘沒更新（臨時休市）都不模擬。</li>
          <li><strong className="text-foreground">18:00</strong> 抓期交所日行情、三大法人、PCR → 檢查停損 → 收盤結算 → 計算訊號 → 產生明天的待成交單與下單建議 → Telegram（21:00 再補跑一次）。</li>
          <li><strong className="text-foreground">週日 20:00</strong> 回測 + 報酬最大化參數測試（walk-forward）。</li>
          <li><strong className="text-foreground">週日 21:30</strong> Claude 排程做每週檢討，必要時送出參數調整提案（選用，見「每週檢討與調校」）。</li>
        </ul>
      </Section>

      <Section icon={Layers} title="訊號怎麼算">
        <ul className="space-y-1.5">
          {TAIFEX_FACTOR_KEYS.map((key) => (
            <li key={key}>
              <span className="font-medium">{FACTOR_LABELS[key].label}</span>
              <span className="text-muted-foreground">（權重 {TAIFEX_FACTOR_WEIGHTS[key]}）：{FACTOR_LABELS[key].desc}。{FACTOR_LABELS[key].source}</span>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground">
          合成分數 = 有資料因子的加權平均 + 輿情（最多 ±0.2）；ADX &lt; {TAIFEX_RULES.adxTrend} 視為盤整，分數打 6 折。
          空手時分數 ≥ +{TAIFEX_RULES.entry} 且趨勢向上才做多（做空對稱）；持倉中分數回到 ±{TAIFEX_RULES.exit} 以內才平倉，強烈反向才反手。
        </p>
      </Section>

      <Section icon={Scale} title="部位與風控">
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>初始停損 {TAIFEX_RULES.stopAtr}×ATR20，移動停損為持倉期間最佳收盤 ∓ {TAIFEX_RULES.trailAtr}×ATR20，只往有利方向移動。</li>
          <li>口數 = 權益 × 每筆風險% ÷（停損點數 × 每點價值），再受保證金使用率 40% 與最大口數限制；波動越大口數越少。</li>
          <li>停損用當天高低價檢查，開盤跳空穿越以開盤價成交，不美化成停損價。</li>
          <li>權益回撤達熔斷門檻 → 平倉並暫停新進場，需手動解除。</li>
          <li>算出 0 口時不進場，請改用較小契約（微台每點 10 元）或提高資金。</li>
        </ul>
      </Section>

      <Section icon={Timer} title="盤中技術模擬（日盤 + 夜盤）">
        <p className="text-muted-foreground">
          與日線波段帳戶完全獨立的實驗：交易時間每 5 分鐘取一次報價、累積 5 分 K，讓四個虛擬機器人分別每 5 / 15 / 30 / 60 分鐘看一次盤，
          用同一套技術指標進出場，比較「多久看一次盤」「日盤還是夜盤」「開盤後多久進場」哪個結果好，作為之後調整演算法的依據（模型版本 {TAIFEX_TECH_RULES.version}）。
        </p>
        <ul className="space-y-1.5">
          {TAIFEX_TECH_FACTOR_KEYS.map((key) => (
            <li key={key}>
              <span className="font-medium">{TECH_FACTOR_LABELS[key].label}</span>
              <span className="text-muted-foreground">（權重 {TAIFEX_TECH_RULES.weights[key]}）：{TECH_FACTOR_LABELS[key].desc}。</span>
            </li>
          ))}
        </ul>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>分數 ≥ +{TAIFEX_TECH_RULES.entry} 且價格在 EMA{TAIFEX_TECH_RULES.emaSlow} 之上做多（做空對稱）；分數回到 {TAIFEX_TECH_RULES.exit} 以下出場，強烈反向則反手。</li>
          <li>停損 {TAIFEX_TECH_RULES.stopAtr}×ATR、移動停損 {TAIFEX_TECH_RULES.trailAtr}×ATR。停損等同掛在交易所，每 5 分鐘都檢查，不受監控頻率影響。</li>
          <li>收盤前 {TAIFEX_TECH_RULES.noEntryMin} 分鐘不開新倉、前 {TAIFEX_TECH_RULES.flatMin} 分鐘一律平倉，不留倉到下一個時段。</li>
          <li>需要 {TAIFEX_TECH_RULES.minBars} 根該頻率的 K 棒才開始決策：5 分頻率約 3 小時，60 分頻率約 2 個交易日。</li>
          <li>夜盤報價需要 Fugle 金鑰（FUGLE_API_KEY）或期交所行情資訊網可連線；取不到報價時該時段不模擬，畫面會顯示原因。</li>
          <li>至少 30 筆交易再比較頻率；成本（手續費、滑價、期交稅）都計入，頻率越高成本越重。</li>
        </ul>
      </Section>

      <Section icon={Swords} title="策略競賽與報酬最大化">
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>基準 / 保守 / 積極 / 最佳化 / Claude 調校五組參數各跑一個虛擬帳戶，同資金、同成本，績效分頁依總報酬排名。</li>
          <li>最佳化：每週用前 60% 歷史找「回撤不超過熔斷上限下報酬最高」的參數，再用沒看過的後 40% 驗證；樣本外沒贏基準就不算數。</li>
          <li>提高每筆風險% 是放大報酬最直接的方法，但虧損也等比例放大；系統會依回測回撤建議上限。</li>
          <li>結論要等至少 60 個交易日或 10 筆交易，樣本太少時看到的高報酬多半是運氣。</li>
        </ul>
      </Section>

      <Section icon={ShieldCheck} title="每週檢討與調校">
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>Claude 每週日透過 MCP 讀取這一週的帳戶、訊號、策略競賽、回測與盤中技術模擬，寫一份檢討；有必要時附上調整提案與「目前 vs 提案」的回測對照。</li>
          <li>提案不會自己生效：到「週檢討」分頁按「套用」才寫入，也可以「退回」；套用後可以還原最近一次。</li>
          <li>可調的只有四區：日線門檻與停損、日線因子權重、資金管理、盤中技術模擬規則。每一項都有寫死的上下限，權重總和固定為 1，超出範圍的提案送出時就被拒絕。</li>
          <li>套用日線門檻或權重後，主帳戶會切到「Claude 調校」策略變體；基準等其他變體照常跑，可以在績效分頁比較調校有沒有比較好。</li>
          <li>本頁上方顯示的權重與門檻是程式內建的預設值；調校後實際生效的值看「週檢討」分頁。</li>
          <li>在 2 年的資料上反覆調參很容易過擬合：單週輸贏不是調整的理由，提案應該有多週證據，樣本外回測變差時不要套用。</li>
          <li>要改公式（加因子、換指標）不走參數調整：Claude 會開 Pull Request 讓你審，合併後升模型版本，新舊版本績效分開看。</li>
        </ul>
      </Section>

      <Section icon={Cpu} title="之後的路線">
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>虛擬帳戶滿 3 個月、與回測方向一致 → 評估接券商 API（永豐 Shioaji、富邦 Neo 等），先以券商模擬環境 + 微台 1 口並行。</li>
          <li>接即時報價或需要大量穩健性測試時，計算引擎改由 Rust 服務（Cloud Run）負責，與現行公式逐筆比對一致後才切換。</li>
        </ul>
      </Section>
    </div>
  );
}

function Section({ icon: Icon, title, children }: { icon: typeof BookOpen; title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Icon className="size-4" aria-hidden /> {title}</CardTitle></CardHeader>
      <CardContent className="space-y-2">{children}</CardContent>
    </Card>
  );
}
