import Anthropic from '@anthropic-ai/sdk';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { messages, projectContext } = req.body || {};
  if (!messages || !messages.length) return res.status(400).json({ error: 'No messages' });

  const client = new Anthropic({ apiKey });
  const ctx = projectContext || {};

  // Build rich system prompt with all project data
  const sys = `You are an expert SEO content strategist and writer for "${ctx.project?.project_name || 'this business'}" (${ctx.project?.url || 'unknown URL'}), a local home services company.

## Your Capabilities
- Write complete blog posts, service pages, and landing page copy optimized for SEO
- Rewrite existing page content (use the fetch_url tool to pull live pages)
- Analyze competitor pages (use fetch_url to read them)
- Generate meta titles, descriptions, and schema markup
- Provide keyword-targeted content strategies with specific recommendations

## Current SEO Data for This Site

### Domain Authority
- Domain Rating: ${ctx.dr?.domain_rating ?? 'N/A'}
- Ahrefs Rank: ${ctx.dr?.ahrefs_rank ? '#' + ctx.dr.ahrefs_rank.toLocaleString() : 'N/A'}

### Traffic & Visibility
- Organic Traffic: ${ctx.metrics?.org_traffic?.toLocaleString() ?? 'N/A'}/mo
- Organic Keywords: ${ctx.metrics?.org_keywords?.toLocaleString() ?? 'N/A'}
- Traffic Value: $${ctx.metrics?.org_cost ? Math.round(ctx.metrics.org_cost / 100).toLocaleString() : 'N/A'}/mo

### Backlink Profile
- Live Backlinks: ${ctx.bl?.live?.toLocaleString() ?? 'N/A'}
- Referring Domains: ${ctx.bl?.live_refdomains?.toLocaleString() ?? 'N/A'}

### Rank Tracker Keywords (positions from Ahrefs RT)
${(ctx.rankings || []).slice(0, 50).map(k => `- "${k.keyword}" → pos ${k.position ?? 'N/R'} (vol: ${k.volume?.toLocaleString() ?? '?'}, traffic: ${k.traffic?.toLocaleString() ?? 0})${k.tags?.length ? ' [' + k.tags.join(', ') + ']' : ''}`).join('\n') || 'No RT data'}

### Top Organic Keywords (from Site Explorer)
${(ctx.organic || []).slice(0, 30).map(k => `- "${k.keyword}" → pos ${k.best_position ?? '?'} (traffic: ${k.sum_traffic?.toLocaleString() ?? 0}, vol: ${k.volume?.toLocaleString() ?? '?'})`).join('\n') || 'No organic data'}

### Google Search Console Data (last 90 days)
${(ctx.gscKeywords || []).slice(0, 25).map(k => `- "${k.keyword}" → ${k.clicks ?? 0} clicks, ${k.impressions?.toLocaleString() ?? 0} imp, ${(k.ctr ?? 0).toFixed(1)}% CTR, pos ${(k.position ?? 0).toFixed(1)}`).join('\n') || 'GSC not connected'}

### Top Pages
${(ctx.pages || []).slice(0, 15).map(p => `- ${p.url}: ${p.sum_traffic?.toLocaleString() ?? 0} traffic, ${p.keywords ?? 0} keywords`).join('\n') || 'No page data'}

### Site Audit Issues
${ctx.audit ? `Health Score: ${ctx.audit.health_score}/100, Errors: ${ctx.audit.urls_with_errors}, Warnings: ${ctx.audit.urls_with_warnings}` : 'No audit data'}
${(ctx.auditIssues || []).filter(i => i.importance === 'Error').slice(0, 10).map(i => `- ERROR: ${i.name} (${i.crawled} URLs)`).join('\n') || ''}

### Competitors
${(ctx.competitors || []).slice(0, 10).map(c => `- ${c.competitor_domain} (DR: ${c.domain_rating?.toFixed(0) ?? '?'}, ${c.keywords_common ?? 0} common KWs)`).join('\n') || 'No competitor data'}

## Instructions
- Always reference specific keywords and their data when making recommendations
- When writing content, naturally incorporate the highest-volume keywords from the data above
- Use the fetch_url tool to read existing pages before rewriting them
- Format output in Markdown with clear headings, bullet points, and structure
- For blog posts, include: suggested title tag, meta description, H1, and full body content
- Be specific and actionable — reference real data points, not generic advice`;

  const tools = [{
    name: 'fetch_url',
    description: 'Fetch the content of a live URL to analyze it. Use this to read existing page content before rewriting, check competitor pages, or analyze any web page. Returns the text content of the page.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The full URL to fetch (include https://)' } },
      required: ['url']
    }
  }];

  // Set up SSE streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e) {} };

  try {
    let conversationMessages = messages.map(m => ({ role: m.role, content: m.content }));
    let toolLoops = 0;
    const MAX_TOOL_LOOPS = 3;

    while (toolLoops <= MAX_TOOL_LOOPS) {
      const stream = await client.messages.stream({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        system: sys,
        messages: conversationMessages,
        tools,
      });

      let fullText = '';
      let toolUseBlocks = [];
      let currentToolUse = null;

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block?.type === 'tool_use') {
            currentToolUse = { id: event.content_block.id, name: event.content_block.name, input: '' };
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta') {
            fullText += event.delta.text;
            send({ type: 'text', text: event.delta.text });
          } else if (event.delta?.type === 'input_json_delta' && currentToolUse) {
            currentToolUse.input += event.delta.partial_json;
          }
        } else if (event.type === 'content_block_stop' && currentToolUse) {
          try { currentToolUse.parsedInput = JSON.parse(currentToolUse.input); } catch(e) { currentToolUse.parsedInput = {}; }
          toolUseBlocks.push(currentToolUse);
          currentToolUse = null;
        }
      }

      // If no tool calls, we're done
      if (toolUseBlocks.length === 0) break;

      // Execute tool calls
      const toolResults = [];
      for (const tool of toolUseBlocks) {
        if (tool.name === 'fetch_url') {
          const fetchUrl = tool.parsedInput.url;
          send({ type: 'status', text: `Fetching ${fetchUrl}...` });
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 10000);
            const r = await fetch(fetchUrl, {
              signal: ctrl.signal,
              headers: { 'User-Agent': 'HarnessSEOBot/1.0' }
            });
            clearTimeout(timer);
            let html = await r.text();
            // Strip HTML tags, scripts, styles to get text content
            html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                       .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                       .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
                       .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
                       .replace(/<[^>]+>/g, ' ')
                       .replace(/\s+/g, ' ')
                       .trim()
                       .slice(0, 50000);
            toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: html || 'Empty page' });
            send({ type: 'status', text: `Fetched ${fetchUrl} (${html.length} chars)` });
          } catch(e) {
            toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: `Failed to fetch: ${e.message}`, is_error: true });
            send({ type: 'status', text: `Failed to fetch ${fetchUrl}` });
          }
        }
      }

      // Build assistant message with tool use blocks for continuation
      const assistantContent = [];
      if (fullText) assistantContent.push({ type: 'text', text: fullText });
      for (const tool of toolUseBlocks) {
        assistantContent.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.parsedInput });
      }

      conversationMessages.push({ role: 'assistant', content: assistantContent });
      conversationMessages.push({ role: 'user', content: toolResults });
      toolLoops++;
    }

    send({ type: 'done' });
    res.end();
  } catch (err) {
    send({ type: 'error', text: err.message || 'Unknown error' });
    res.end();
  }
}
