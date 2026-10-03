import mermaid from 'mermaid';
import createDOMPurify from 'dompurify';
const rendered = new WeakMap<HTMLElement,string>();
let serial=0, queue=Promise.resolve();
const purify=createDOMPurify(window);
export function safeDiagramSvg(svg:string) {
  const clean=purify.sanitize(svg,{USE_PROFILES:{svg:true,svgFilters:true},FORBID_TAGS:['script','foreignObject','image','a','iframe','object','embed'],FORBID_ATTR:['href','xlink:href','src','onload','onclick'],ALLOW_DATA_ATTR:false});
  // Diagram definitions may contain CSS; permit local SVG paint references only.
  return clean.replace(/@import[^;]*;/gi,'').replace(/url\(\s*([^)]*)\)/gi,(_all,value:string)=>{
    const target=value.trim().replace(/^['"]|['"]$/g,'');
    return /^#[a-zA-Z0-9_-]+$/.test(target)?`url(${target})`:'none';
  });
}
export function renderDiagrams(root:HTMLElement) {
  const dark=window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme=document.body.classList.contains('vscode-light')||document.body.classList.contains('vscode-high-contrast-light')?'default':document.body.classList.contains('vscode-dark')?'dark':dark?'dark':'default';
  for(const figure of root.querySelectorAll<HTMLElement>('.mermaid-diagram.diagram-ready')) {
    const source=figure.querySelector('code')?.textContent||'', key=theme+source;
    if(rendered.get(figure)===key)continue;rendered.set(figure,key);
    const canvas=figure.querySelector<HTMLElement>('.diagram-canvas')!;
    canvas.textContent='正在绘制流程图…';
    queue=queue.catch(()=>{}).then(async()=>{
      if(!figure.isConnected)return;
      const stage=document.createElement('div');stage.className='diagram-stage';document.body.append(stage);
      try {
        if(source.length>30000 || /^\s*---/.test(source) || /%%\s*\{/.test(source))throw new Error('图表过大或包含不支持的配置指令');
        mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme,htmlLabels:false,flowchart:{htmlLabels:false},maxTextSize:30000,maxEdges:400,suppressErrorRendering:true,
          secure:['securityLevel','startOnLoad','maxTextSize','maxEdges','htmlLabels','flowchart','theme','themeVariables','suppressErrorRendering']});
        const {svg}=await mermaid.render(`pi-diagram-${++serial}`,source,stage);
        if(!figure.isConnected||rendered.get(figure)!==key)return;
        canvas.innerHTML=safeDiagramSvg(svg);canvas.dataset.rendered='true';
      }catch(error){
        canvas.textContent='流程图暂时无法渲染，请展开源码检查语法。';canvas.classList.add('diagram-error');
        canvas.dataset.tooltip=error instanceof Error?error.message.slice(0,200):'图表语法错误';
      }finally{stage.remove();}
    });
  }
}
