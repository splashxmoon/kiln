import { useId } from 'react'
import { Bot, Code2, Globe } from 'lucide-react'

/**
 * Each coding tool's own mark, so the picker shows which one is active. The marks
 * come from LobeHub's icon set (@lobehub/icons,
 * MIT). Claude and Gemini keep their brand colours. OpenAI (Codex), Cursor
 * and OpenCode are black and white in their own branding, so they take the text
 * colour. Providers without a published mark fall back to a plain glyph.
 */

type Mark = 'claude' | 'openai' | 'gemini' | 'cursor' | 'opencode'

const MARKS: Record<string, Mark> = {
  'cli:claude': 'claude',
  'cli:codex': 'openai',
  'cli:gemini': 'gemini',
  'cli:cursor-agent': 'cursor',
  'cli:opencode': 'opencode',
  'api:anthropic': 'claude',
  'api:openai': 'openai',
}

const FALLBACK = { 'api:openrouter': Globe, 'api:ollama': Code2 } as Record<string, typeof Bot>

const CLAUDE =
  'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z'

const OPENAI =
  'M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z'

const CURSOR =
  'M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z'

const OPENCODE = 'M16 6H8v12h8V6zm4 16H4V2h16v20z'

const GEMINI_TILE =
  'M0 4.391A4.391 4.391 0 014.391 0h15.217A4.391 4.391 0 0124 4.391v15.217A4.391 4.391 0 0119.608 24H4.391A4.391 4.391 0 010 19.608V4.391z'
const GEMINI_INNER =
  'M19.74 1.444a2.816 2.816 0 012.816 2.816v15.48a2.816 2.816 0 01-2.816 2.816H4.26a2.816 2.816 0 01-2.816-2.816V4.26A2.816 2.816 0 014.26 1.444h15.48zM7.236 8.564l7.752 3.728-7.752 3.727v2.802l9.557-4.596v-3.866L7.236 5.763v2.801z'

function GeminiMark({ size }: { size: number }) {
  // the gradient needs an id that is unique per instance: the trigger and the picker can both show it
  const grad = `k-gemini-${useId().replace(/:/g, '')}`
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="k-agent-provider-icon" aria-hidden="true">
      <defs>
        <linearGradient id={grad} gradientUnits="userSpaceOnUse" x1="24" x2="0" y1="6.587" y2="16.494">
          <stop stopColor="#EE4D5D" />
          <stop offset=".328" stopColor="#B381DD" />
          <stop offset=".476" stopColor="#207CFE" />
        </linearGradient>
      </defs>
      <path d={GEMINI_TILE} fill={`url(#${grad})`} />
      <path d={GEMINI_INNER} fill="#1E1E2E" fillRule="evenodd" clipRule="evenodd" />
    </svg>
  )
}

export function ProviderIcon({ id, size = 13 }: { id: string | undefined; size?: number }) {
  const mark = id ? MARKS[id] : undefined
  if (mark === 'gemini') return <GeminiMark size={size} />
  if (mark) {
    // the marks' own fill rules: Claude and OpenAI are drawn nonzero, Cursor and OpenCode cut holes with evenodd
    const [d, box, fill, rule] =
      mark === 'claude'
        ? [CLAUDE, '0 0 24 24', '#D97757', 'nonzero']
        : mark === 'openai'
          ? [OPENAI, '0 0 256 260', 'currentColor', 'nonzero']
          : mark === 'cursor'
            ? [CURSOR, '0 0 24 24', 'currentColor', 'evenodd']
            : [OPENCODE, '0 0 24 24', 'currentColor', 'evenodd']
    return (
      <svg width={size} height={size} viewBox={box} className="k-agent-provider-icon is-mark" aria-hidden="true">
        <path d={d} fill={fill} fillRule={rule as 'nonzero' | 'evenodd'} />
      </svg>
    )
  }
  const Icon = (id && FALLBACK[id]) || Bot
  return <Icon size={size} className="k-agent-provider-icon" aria-hidden="true" />
}
