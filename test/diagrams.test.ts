// @vitest-environment jsdom
import {it,expect} from 'vitest';
import {safeDiagramSvg} from '../webview/diagrams';
it('removes executable SVG and external resources while retaining local arrow markers',()=>{
 const result=safeDiagramSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><foreignObject><div>html</div></foreignObject><image href="https://example.com/track"/><a href="javascript:alert(1)"><text>link</text></a><style>.bad{fill:url(https://example.com/a)} .local{marker-end:url("#arrow")}</style><path marker-end="url(#arrow)" onclick="alert(1)"/></svg>');
 expect(result).not.toMatch(/<script|<foreignObject|<image|<a\s|onclick|https:/);expect(result).toContain('url(#arrow)');
});
