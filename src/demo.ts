export const demoMarkdown = String.raw`# 让公式成为对话的一部分

这里支持 **Markdown**、数学公式、代码高亮和表格。行内公式 $E=mc^2$ 与 \(e^{i\pi}+1=0\) 可以自然混排。

## 微积分与概率

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx=\sqrt{\pi},\qquad
p(\theta\mid x)=\frac{p(x\mid\theta)p(\theta)}{p(x)}
$$

\[
\nabla_{\!\theta}\mathcal{L}=\frac1N\sum_{i=1}^{N}\nabla_{\!\theta}\ell(f_\theta(x_i),y_i)
\]

## 矩阵、多行推导与分段函数

\begin{align}
(A+B)^2 &= A^2+AB+BA+B^2 \\
\mathbf{A} &= \begin{bmatrix}1&2\\3&4\end{bmatrix}
\end{align}

$$
f(x)=\begin{cases}x^2 & x\geq 0\\-x & x<0\end{cases}
\qquad \ce{2H2 + O2 -> 2H2O}
$$

| 语法 | 用途 |
| --- | --- |
| $\sum_{k=1}^n k$ | 求和 |
| $\mathbb{R}^{d\times d}$ | 张量空间 |

> 公式由本地 KaTeX 渲染，同时保留 MathML 供辅助技术读取。

- [x] 流式 Markdown 和数学公式
- [x] 代码围栏中的美元符号保持原样
- [ ] 连接你的 Pi Agent

\`\`\`python
import numpy as np
# $x$ stays literal inside code
A = np.array([[1, 2], [3, 4]])
print(np.linalg.eigvals(A))
\`\`\`

普通价格 $5 和 $10 不应被误当作公式。未完成的公式保留文本，不打断整条消息。
`.replaceAll('\\`', '`');
