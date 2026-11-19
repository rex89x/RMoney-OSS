import type { ReactNode } from 'react';
import { BookOpen, Bot, CircleHelp, Layers, LayoutDashboard, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FLIGHT_INGEST_ENV_VAR } from '../claude-schedule';

/**
 * 機票雷達的 App 內操作說明。完整版（含設定截圖位置、安全設計細節）在 docs/USER_GUIDE.md，
 * 兩邊內容有改要一起更新。
 */
const SOURCES = [
  { name: 'Claude 排程推送', cost: '不另付 API 費用（用 Claude 方案額度）', when: '你在 Claude 設定的排程時間', fit: '日常追蹤，推薦' },
  { name: 'Claude API + Web Search', cost: '扣 Claude API 額度（每次約 US$0.05–0.30）', when: '每天 09:00 或「立即更新」', fit: '需要隨時手動刷新' },
  { name: 'Duffel API', cost: '可能有超額搜尋費', when: '每天 09:00 或「立即更新」', fit: '需要可售即時報價' },
];

export function FlightRadarGuide() {
  return (
    <div className="space-y-4 text-sm leading-relaxed">
      <GuideSection icon={BookOpen} title="名詞">
        <ul className="list-disc space-y-1 pl-5">
          <li><b>航線</b>：出發機場 → 抵達機場，例如 TPE → NRT。</li>
          <li><b>日期區段</b>：同一條航線的一段可出發日期，例如「寒假 1/20–2/10」。一條航線可以有多個區段，各自獨立掃描、各自有理想價與通知設定。</li>
          <li><b>行程</b>：每個區段可選<b>來回</b>、<b>單程</b>或<b>多點進出</b>（A 進 B 出，例：TPE → 東京 NRT 進、大阪 KIX → TPE 出）。單程不需要晚數；多點進出跟來回一樣設晚數（去程出發到回程出發），價格是同一張多城市機票的合計，不是兩張單程相加。三種不會混在一起比較。</li>
          <li><b>購票方式</b>：來回與多點進出可選「只要一張票」、「只看拼單程」（去回各買一張單程）或「兩種都比」（多點進出預設）。拼單程常更便宜也更容易查到價，但兩張票互不保障、行李要各自買；結果會標「拼單程」並列出去 / 回各段價格。</li>
          <li><b>較低價 / 常見價</b>：該區段目前查到「合理可買到的便宜價」與「一般價位」，都是所有旅客合計的含稅價（TWD，依區段是單程或來回）。</li>
          <li><b>候選日期</b>：每次掃描最多保存 12 組具體的出發（／回程）日期與價格，盡量分散在不同週與晚數，用來比較哪段時間出發便宜。</li>
          <li><b>歷史最低</b>：這個區段開始追蹤以來看過的最低較低價。</li>
        </ul>
      </GuideSection>

      <GuideSection icon={Layers} title="三種資料來源">
        <div className="grid gap-2 sm:grid-cols-3">
          {SOURCES.map((source) => (
            <div key={source.name} className="rounded-lg border p-3 text-xs">
              <div className="mb-1 text-sm font-medium">{source.name}</div>
              <div><span className="text-muted-foreground">費用：</span>{source.cost}</div>
              <div><span className="text-muted-foreground">更新：</span>{source.when}</div>
              <div><span className="text-muted-foreground">適合：</span>{source.fit}</div>
            </div>
          ))}
        </div>
      </GuideSection>

      <GuideSection icon={Bot} title="設定 Claude 排程（第一次）">
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            <b>設定航線</b>：「航線」分頁新增或編輯區段，選來回、單程或多點進出，「掃描方式」選 <b>Claude 排程推送</b>，並選一個 <b>Claude 排程群組</b>（可直接輸入新群組名稱），儲存。
          </li>
          <li>
            <b>產生 token</b>：按「Claude 排程」→「產生 token」，複製。只會顯示一次，不要貼到任何聊天裡。
          </li>
          <li>
            <b>建立 Claude 雲端環境</b>：到 claude.ai/code，開新 session 畫面點訊息框下方第一個控制項 → New environment：
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
              <li>名稱：<code className="rounded bg-muted px-1">flight-radar</code>（專用，避免其他工作帶到 token）</li>
              <li>Environment variables：<code className="break-all rounded bg-muted px-1">{FLIGHT_INGEST_ENV_VAR}=剛剛的token</code></li>
              <li>Network access 選 Custom，Allowed domains 填 <code className="rounded bg-muted px-1">script.google.com</code> 與 <code className="rounded bg-muted px-1">script.googleusercontent.com</code>，勾選 include default list</li>
            </ul>
          </li>
          <li>
            <b>複製提示詞</b>：「Claude 排程」→ 點選群組 → 複製該群組的提示詞。一個群組對應一個 Claude 排程任務。
          </li>
          <li>
            <b>建立排程任務</b>：到 claude.ai/code/routines → New task：
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
              <li>Prompt：貼上提示詞</li>
              <li>Trigger：Schedule → Daily，時間避開整點（例如 7:07）</li>
              <li>Advanced settings：Repository 選你自己的這個 repo、Cloud environment 選 flight-radar、Connectors 全部移除</li>
            </ul>
          </li>
          <li>
            <b>驗證</b>：任務頁按 Run now，跑完回來看卡片價格與「最後推送」時間；失敗時卡片會顯示原因。
          </li>
        </ol>
      </GuideSection>

      <GuideSection icon={Layers} title="新增航線或多個日期區段之後">
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            <b>同航線加區段</b>：卡片上的「同航線新增日期區段」按鈕會沿用條件、日期往後接續，填個區段名稱（例如「春節」）就能分開追蹤。列表會把同航線的區段放在同一組。
          </li>
          <li>
            <b>Claude 不會自動知道新區段</b>：新增、修改日期／艙等／航空公司條件後，「Claude 排程」裡該區段會顯示「尚未加入排程」或「條件已改，需重新複製」。重新複製提示詞，到 Claude 排程任務 Edit 換掉 Prompt。
          </li>
          <li>
            <b>區段很多時分組</b>：在航線表單或「Claude 排程」把區段放進不同群組（例如日本線、歐洲線），每個群組各建一個排程任務，每次查價比較快也比較準。群組可隨時新增、改名（把區段移到新群組）或移動；移動後兩邊群組的提示詞都要重新複製。推送會自動每 10 條分一批。
          </li>
          <li>
            <b>暫停或過期</b>：關掉卡片開關，或最晚出發日已過的區段不會出現在提示詞；排程送來也會被拒收。
          </li>
        </ul>
      </GuideSection>

      <GuideSection icon={LayoutDashboard} title="看懂總覽">
        <ul className="list-disc space-y-1.5 pl-5">
          <li><b>上方篩選</b>：行程（全部／來回／單程／多點）、艙等、航線，總覽與航線列表一起套用。</li>
          <li><b>目前最低價機票</b>：每個區段最便宜的一組日期做成機票樣式，有航班號、起降時間、飛行時間、艙等、轉機與價格（來源有提供才顯示時間）。</li>
          <li><b>分析區段</b>：「哪段時間出發最便宜」「候選日期評估」「出發日與票價」「航班細節」右上可選要分析哪個區段，預設最便宜的那個；不同航線或單程／來回混著比會失真，需要時再選「全部區段」。</li>
          <li><b>哪段時間出發最便宜</b>：每週一格，格子越深越便宜，最便宜三週標「推薦」；下面有週幾出發、住幾晚的最低價（在同一個艙等內比較）。</li>
          <li><b>候選日期評估</b>：攤開所有候選日期，可依價格／出發日／比最低差距排序，篩平日或週五六出發、只看直飛，並標出區段最低、直飛最低、達理想價。</li>
          <li><b>艙等價差、出發日與票價、航班時段／航空公司／直飛</b>：比較各艙等差多少、哪些出發日便宜、哪個時段與航空公司最便宜、直飛比轉機貴多少。</li>
          <li><b>需要處理、各區段目前價格、走勢比較</b>：問題清單、目前價 vs 歷史最低 vs 理想價、每天一點的價格走勢。</li>
          <li><b>調整版面</b>：總覽右上「調整版面」可開關與排序每個區塊，設定記在你的帳號。</li>
          <li>首頁 Dashboard 也可以開啟「機票雷達」卡片，看最便宜的幾個區段與待處理數量。</li>
        </ul>
      </GuideSection>

      <GuideSection icon={ShieldCheck} title="安全設計">
        <ul className="list-disc space-y-1 pl-5">
          <li>推送 token 只能寫入「Claude 排程推送」且啟用中的區段票價，不能讀取任何資料；伺服器只存雜湊值。</li>
          <li>外洩或懷疑外洩時：「Claude 排程」→ 重新產生 token（舊的立即失效），再更新 Claude 環境變數。</li>
          <li>價格、日期、晚數、艙等、直飛、廉航與航空公司條件都會在伺服器重新檢查；比前次常見價低 60% 以上會標成低可信度，不更新歷史最低、不發低價通知。</li>
        </ul>
      </GuideSection>

      <GuideSection icon={CircleHelp} title="常見問題">
        <dl className="space-y-2">
          <Faq q="「Claude 排程」裡沒有提示詞">沒有任何區段的掃描方式是 Claude 排程推送，或都已暫停／過期。對話框會列出每個區段不納入的原因。</Faq>
          <Faq q="卡片顯示「搜尋條件已變更」">條件改過了，重新複製提示詞並更新 Claude 排程任務的 Prompt。</Faq>
          <Faq q="Claude 執行紀錄出現 403 host_not_allowed">雲端環境的 Allowed domains 少了 script.google.com 或 script.googleusercontent.com。</Faq>
          <Faq q="排程顯示 Succeeded 但價格沒更新">Succeeded 只代表 session 正常結束。打開該次執行看推送回應，results 裡會寫每個區段被拒收的原因。</Faq>
          <Faq q="排程無法連網">Claude 會在回覆輸出 JSON，整段貼到「Claude 排程 → 貼上結果」即可，驗證規則相同。</Faq>
        </dl>
      </GuideSection>
    </div>
  );
}

function GuideSection({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Icon className="size-4" /> {title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-medium">{q}</dt>
      <dd className="text-muted-foreground">{children}</dd>
    </div>
  );
}
