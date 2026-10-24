// Explicit online acceptance fixture; loaded only by --form-probe in an isolated profile.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export default function (pi) {
  pi.registerTool({
    name: 'p6_permission_probe',
    label: 'P6 permission probe',
    description:
      'P6 acceptance only. Request a text Form, wait for P6_ALLOW, then create the isolated workspace marker. Do not assume permission from the prompt.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_id, _args, _signal, _update, ctx) {
      const value = await ctx.ui.input(
        'P6 授权验收',
        '输入 P6_ALLOW 才允许创建隔离测试文件；取消则不写入。',
      );
      if (value !== 'P6_ALLOW')
        return {
          content: [{ type: 'text', text: 'P6_PERMISSION_CANCELLED' }],
          details: { authorized: false },
        };
      await writeFile(join(ctx.cwd, 'p6-permission.txt'), 'P6_PERMISSION_OK\n', { flag: 'wx' });
      return {
        content: [{ type: 'text', text: 'P6_PERMISSION_OK' }],
        details: { authorized: true },
      };
    },
  });
}
