import re, sys

def md_to_html(md_text):
    """Simple markdown to HTML converter for legal docs."""
    lines = md_text.strip().split('\n')
    html_parts = []
    in_list = False
    in_table = False
    table_header_done = False
    
    for line in lines:
        stripped = line.strip()
        
        # Skip empty lines
        if not stripped:
            if in_list:
                html_parts.append('</ul>')
                in_list = False
            if in_table:
                html_parts.append('</tbody></table>')
                in_table = False
                table_header_done = False
            html_parts.append('')
            continue
        
        # Horizontal rules
        if stripped == '---':
            if in_list:
                html_parts.append('</ul>')
                in_list = False
            html_parts.append('<hr>')
            continue
        
        # Table rows
        if '|' in stripped and stripped.startswith('|'):
            cells = [c.strip() for c in stripped.split('|')[1:-1]]
            # Skip separator rows
            if all(set(c) <= set('-: ') for c in cells):
                continue
            if not in_table:
                html_parts.append('<div class="table-wrap"><table>')
                html_parts.append('<thead><tr>')
                for cell in cells:
                    cell = inline_format(cell)
                    html_parts.append(f'<th>{cell}</th>')
                html_parts.append('</tr></thead><tbody>')
                in_table = True
                table_header_done = True
                continue
            else:
                html_parts.append('<tr>')
                for cell in cells:
                    cell = inline_format(cell)
                    html_parts.append(f'<td>{cell}</td>')
                html_parts.append('</tr>')
                continue
        
        if in_table and not ('|' in stripped):
            html_parts.append('</tbody></table></div>')
            in_table = False
            table_header_done = False
        
        # Headers
        if stripped.startswith('# '):
            if in_list:
                html_parts.append('</ul>')
                in_list = False
            html_parts.append(f'<h1>{inline_format(stripped[2:])}</h1>')
            continue
        if stripped.startswith('## '):
            if in_list:
                html_parts.append('</ul>')
                in_list = False
            # Generate id from text
            text = stripped[3:]
            id_text = re.sub(r'[^\w\s-]', '', text.lower()).strip().replace(' ', '-')
            html_parts.append(f'<h2 id="{id_text}">{inline_format(text)}</h2>')
            continue
        if stripped.startswith('### '):
            if in_list:
                html_parts.append('</ul>')
                in_list = False
            html_parts.append(f'<h3>{inline_format(stripped[4:])}</h3>')
            continue
        
        # List items
        if stripped.startswith('- '):
            if not in_list:
                html_parts.append('<ul>')
                in_list = True
            html_parts.append(f'<li>{inline_format(stripped[2:])}</li>')
            continue
        
        # Numbered list
        if re.match(r'^\d+\.\s', stripped):
            text = re.sub(r'^\d+\.\s', '', stripped)
            if not in_list:
                html_parts.append('<ol>')
                in_list = True  
            html_parts.append(f'<li>{inline_format(text)}</li>')
            continue
        
        # Paragraphs
        if in_list:
            html_parts.append('</ul>' if True else '</ol>')
            in_list = False
        html_parts.append(f'<p>{inline_format(stripped)}</p>')
    
    if in_list:
        html_parts.append('</ul>')
    if in_table:
        html_parts.append('</tbody></table></div>')
    
    return '\n'.join(html_parts)

def inline_format(text):
    """Handle bold, italic, links, inline code."""
    # Links [text](url)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2" target="_blank" rel="noopener">\1</a>', text)
    # Bold
    text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
    # Italic
    text = re.sub(r'\*([^*]+)\*', r'<em>\1</em>', text)
    # Inline code
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    # Section refs like [Section 4](#4...)
    text = re.sub(r'<a href="#([^"]+)"', r'<a href="#\1"', text)
    return text

def make_page(title, md_content, back_text="Back to Wellet"):
    body_html = md_to_html(md_content)
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} — Wellet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Serif+Display&display=swap" rel="stylesheet">
<style>
  :root {{
    --moss: #608F7C;
    --moss-dark: #3D6B58;
    --mint: #E8F0EB;
    --cream: #FAF9F7;
    --text-primary: #1a1a1a;
    --text-secondary: #555;
    --text-muted: #888;
  }}
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{
    font-family: 'DM Sans', sans-serif;
    background: var(--cream);
    color: var(--text-primary);
    line-height: 1.7;
    -webkit-font-smoothing: antialiased;
  }}
  .legal-header {{
    background: white;
    border-bottom: 1px solid #e8e5e0;
    padding: 16px 24px;
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 12px;
  }}
  .legal-header a {{
    color: var(--moss-dark);
    text-decoration: none;
    font-size: 14px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 6px;
  }}
  .legal-header a:hover {{ text-decoration: underline; }}
  .legal-header svg {{ width: 16px; height: 16px; }}
  .legal-container {{
    max-width: 720px;
    margin: 0 auto;
    padding: 40px 24px 80px;
  }}
  h1 {{
    font-family: 'DM Serif Display', serif;
    font-size: 32px;
    font-weight: 400;
    margin-bottom: 8px;
    color: var(--text-primary);
  }}
  h2 {{
    font-family: 'DM Serif Display', serif;
    font-size: 22px;
    font-weight: 400;
    margin-top: 40px;
    margin-bottom: 12px;
    color: var(--text-primary);
  }}
  h3 {{
    font-family: 'DM Sans', sans-serif;
    font-size: 16px;
    font-weight: 600;
    margin-top: 24px;
    margin-bottom: 8px;
    color: var(--text-primary);
  }}
  p {{
    margin-bottom: 14px;
    font-size: 15px;
    color: var(--text-secondary);
  }}
  ul, ol {{
    margin: 12px 0 14px 24px;
    font-size: 15px;
    color: var(--text-secondary);
  }}
  li {{
    margin-bottom: 6px;
    padding-left: 4px;
  }}
  a {{
    color: var(--moss-dark);
    text-decoration: underline;
    text-underline-offset: 2px;
  }}
  a:hover {{ color: var(--moss); }}
  strong {{ color: var(--text-primary); font-weight: 600; }}
  hr {{
    border: none;
    border-top: 1px solid #e8e5e0;
    margin: 32px 0;
  }}
  code {{
    background: var(--mint);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 13px;
  }}
  .table-wrap {{
    overflow-x: auto;
    margin: 16px 0;
  }}
  table {{
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }}
  th, td {{
    text-align: left;
    padding: 10px 14px;
    border-bottom: 1px solid #e8e5e0;
  }}
  th {{
    background: var(--mint);
    font-weight: 600;
    color: var(--text-primary);
    font-size: 13px;
  }}
  td {{ color: var(--text-secondary); }}
  .effective-date {{
    font-size: 14px;
    color: var(--text-muted);
    margin-bottom: 32px;
  }}
  @media (max-width: 600px) {{
    h1 {{ font-size: 26px; }}
    h2 {{ font-size: 19px; }}
    .legal-container {{ padding: 24px 16px 60px; }}
  }}
</style>
</head>
<body>
<header class="legal-header">
  <a href="/">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
    {back_text}
  </a>
</header>
<main class="legal-container">
{body_html}
</main>
</body>
</html>'''

# Read and generate
with open('/home/user/workspace/wellet-privacy-policy.md', 'r') as f:
    privacy_md = f.read()

with open('/home/user/workspace/wellet-terms-of-service.md', 'r') as f:
    terms_md = f.read()

with open('/home/user/workspace/wellet-23c5bebf/privacy.html', 'w') as f:
    f.write(make_page('Privacy Policy', privacy_md))

with open('/home/user/workspace/wellet-23c5bebf/terms.html', 'w') as f:
    f.write(make_page('Terms of Service', terms_md))

print("Generated privacy.html and terms.html")
