// Just enough markdown for Claude's rules summaries: headings, lists, bold,
// italics, inline code, paragraphs. Everything is escaped first.

export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[c])

const inline = s => escapeHtml(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')

export const renderMarkdown = md => {
  const out = []
  let list = null
  let para = []
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`)
    list = null
  }
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trim()
    const h = line.match(/^(#{1,4})\s+(.*)/)
    const ul = line.match(/^[-*•]\s+(.*)/)
    const ol = line.match(/^\d+[.)]\s+(.*)/)
    if (!line) { flushPara(); flushList(); continue }
    if (h) { flushPara(); flushList(); out.push(`<h${Math.min(4, h[1].length + 2)}>${inline(h[2])}</h${Math.min(4, h[1].length + 2)}>`); continue }
    if (ul || ol) {
      flushPara()
      const tag = ul ? 'ul' : 'ol'
      if (list?.tag !== tag) { flushList(); list = {tag, items: []} }
      list.items.push((ul || ol)[1])
      continue
    }
    flushList()
    para.push(line)
  }
  flushPara()
  flushList()
  return out.join('\n')
}
