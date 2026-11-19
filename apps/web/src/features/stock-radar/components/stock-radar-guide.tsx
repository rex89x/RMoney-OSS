import { AlertTriangle, BookOpen, ClipboardCheck, Clock, Newspaper, Scale } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CLAUDE_SCHEDULE_TIME } from '../claude-schedule';
import { ACTION_META, FACTOR_META, SENTIMENT_RULES } from '../options';
import { STOCK_RADAR_FACTOR_KEYS } from '../types';

/** App 內使用說明；內容與 docs/USER_GUIDE.md「股市雷達」章節一起更新 */
export function StockRadarGuide() {
  return (
    <div className="space-y-4 text-sm">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><Clock className="size-4" /> 什麼時候更新</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-muted-foreground">
          <p>01:00 同步前一交易日台股三大法人與融資餘額（證交所公開資料）。</p>
          <p>Claude 排程：台股 {CLAUDE_SCHEDULE_TIME.TW}、美股 {CLAUDE_SCHEDULE_TIME.US} 上網整理輿情並推送。</p>
          <p>08:00 評估台股與美股（台股日 K 前一晚 18:00、美股日 K 07:00 已更新），合併已收到的輿情，Telegram 推播台股建議。</p>
          <p>美股：晚上 Claude 推送後重新合成並推播；21:00 前沒收到就推播純量化結果。台股輿情晚到時只推播動作有變化的標的。</p>
          <p>評估範圍是「投資」頁的持股與自選股。新加入的股票第一次評估時會自動補 2 年日 K。「重新評估」會覆寫當天結果。</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><BookOpen className="size-4" /> 因子與論文</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {STOCK_RADAR_FACTOR_KEYS.map((key) => (
              <li key={key}>
                <p className="font-medium">{FACTOR_META[key].label}<span className="ml-1.5 text-xs text-muted-foreground">權重 {FACTOR_META[key].weight}</span></p>
                <p className="text-muted-foreground">{FACTOR_META[key].description}</p>
                <p className="text-xs text-muted-foreground">{FACTOR_META[key].paper}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            法人籌碼與融資只有上市股票有資料（上櫃、美股不計入）。
            個人追蹤清單檔數少，不做橫斷面排名，而是把每個因子用文獻的定義轉成 -1 ~ +1 再加權平均
            （DeMiguel, Garlappi & Uppal 2009：簡單等權常勝過最佳化權重）。參數凍結在模型版本，不用自己的少量資料調參。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><Newspaper className="size-4" /> 輿情怎麼影響分數</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-muted-foreground">
          <p>
            Claude 依 Loughran & McDonald (2011) 財經詞典精神給 -1 ~ +1 的輿情與 0 ~ 1 的信心；加減分 = 輿情 × 信心 × {SENTIMENT_RULES.weight}，
            財報優於／低於預期再 ±{SENTIMENT_RULES.pead}（Bernard & Thomas 1989 財報後漂移），總影響上限 ±{SENTIMENT_RULES.maxAdj}。
          </p>
          <p>媒體負面語氣對隔日報酬有預測力（Tetlock 2007）；社群討論對方向的預測力弱、對波動較有用（Antweiler & Frank 2004），所以社群只能小幅影響。</p>
          <p>沒有 https 來源的評分不計分。評估日前 2 天到後 5 天內有財報、增資、訴訟、降評、財測 → 暫緩加碼與買進。</p>
          <p>市場整體輿情 ≤ -0.5 且信心 ≥ 0.6 → 大盤燈號下修一級（Baker & Wurgler 2006）。</p>
          <p>Claude 只看得到代號與名稱，看不到股數與成本；最終動作一律由固定公式決定，不採用模型的買賣建議。</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><Scale className="size-4" /> 動作怎麼決定</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-muted-foreground">
          <ul className="list-disc space-y-1 pl-5">
            <li>持有中：分數 ≥ +0.35 → {ACTION_META.add.label}；≤ -0.15 → {ACTION_META.trim.label}；≤ -0.45 → {ACTION_META.exit.label}；其餘 {ACTION_META.hold.label}。</li>
            <li>自選股：分數 ≥ +0.35 → {ACTION_META.buy.label}；≥ 0 → {ACTION_META.watch.label}；其餘 {ACTION_META.avoid.label}。</li>
            <li>大盤偏空（0050／SPY 跌破 200 日均線且 12 個月動能為負）：不建議加碼，買進門檻提高到 +0.55（Faber 2007）。</li>
            <li>跌破吊燈停損（22 日最高 − 3 × ATR14）：持股至少減碼、自選股不列買進。</li>
            <li>單檔占股票部位 ≥ 25%：分數再強也只建議續抱。</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><ClipboardCheck className="size-4" /> 成績單與回測</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-muted-foreground">
          <p>成績單：每天回填過去建議從「隔天開盤」進場後 1／5／20 個交易日、相對大盤的超額報酬，計算命中率與 IC（分數與報酬的排名相關）。也會比較「合成分數」與「純量化分數」，看輿情有沒有幫到。</p>
          <p>回測：每週日用 5 年日 K 做 walk-forward，只用價格因子；標的是目前清單，會有倖存者偏差，結果偏樂觀。</p>
          <p>公式參數不依成績單或回測調整；要改公式就升模型版本，新舊版本成績分開看（Bailey & López de Prado 2014 過度擬合警告）。</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className="size-4" /> 限制</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-muted-foreground">
          <p>論文中的超額報酬是大量股票、長期間的統計平均，且多為扣除交易成本前；單一股票、短期間可能完全相反。</p>
          <p>輿情來自 Claude 的網路搜尋整理，可能漏抓或誤讀，請點來源查證。台股籌碼為前一交易日資料。</p>
          <p>本功能只提供決策參考，不會自動下單，也不構成投資建議。</p>
        </CardContent>
      </Card>
    </div>
  );
}
