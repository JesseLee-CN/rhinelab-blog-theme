"""本地复现上游 Novecento 字形导出（仅用于验证与生成本站补充短语）。

与上游 scripts/make-boot-lettering.py 的差别：
  1. 不做 sys.path 注入，直接用本机 fontTools / Pillow；
  2. 支持 --out 指定输出路径（上游固定写 src/boot-lettering-art.json）；
  3. 只导出给定字重里存在的短语，并支持本站补充短语（如身份行）。

许可：字形来源为 DaFont 免费包（Synthview Free Font License），该许可明确允许把
字符作为图形对象导入（描边转矢量）；字体文件本身不得再分发、不得做字体格式转换。
输出仅为固定短语的描边图形。
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

# 上游的 width 等于字体原始 advance（不含 kerning）——138 个字母逐一对齐验证，
# 因此这里直接用 hmtx，不依赖 Pillow（上游用 Pillow 的 pair 计算，其结果同样是
# 未套用 kerning 的 advance）。

UPSTREAM_PHRASES = [
    ('brand', 'RHINE LAB', 'DemiBold'),
    ('access', 'ACCESS PERMISSION REQUIRED', 'Normal'),
    ('identity', 'ID CONFIRMED : JOYCE MOORE', 'Normal'),
    ('request', 'REQUEST RECEIVED', 'Normal'),
    ('processing', 'START PROCESSING...', 'Normal'),
    ('processingGlitch', '              SING...', 'Normal'),
    ('permission', 'PERMISSION AUTHORIZED', 'Normal'),
    ('welcome', 'WELCOME TO', 'Bold'),
    ('company', 'RHINE LAB.LLC.', 'Bold'),
    ('database', 'INTERNAL DATABASE', 'Bold'),
]

# 本站补充：身份行是动态注册名，这里为实际会出现的固定标签预生成图形。
# 上游的 identity 键（"ID CONFIRMED : JOYCE MOORE"）是对方站点的显示名，本站不用。
LOCAL_PHRASES = [
    ('identityOwner', 'ID CONFIRMED : JOYCE MOORE', 'Normal'),
    ('identityGuest', 'ID CONFIRMED : GUEST', 'Normal'),
]

# 免费 DaFont 包不含 Bold；Bold 三句沿用上游已提交的图形（其来源为 MyFonts 桌面包，
# 而 FontSquirrel 的免费 6 字重同样包含 Bold，许可上成立）。
BOLD_FROM_UPSTREAM = ['welcome', 'company', 'database']


def export(fonts: Path, out: Path, phrases, weights=('Normal', 'DemiBold', 'Bold')):
    art, sources, missing = {}, {}, []
    for weight in weights:
        path = fonts / f'Novecentosanswide-{weight}.otf'
        if not path.exists():
            missing.append(weight)
            continue
        font = TTFont(path)
        units = font['head'].unitsPerEm
        glyphs, cmap, hmtx = font.getGlyphSet(), font.getBestCmap(), font['hmtx']
        sources[weight] = {
            'filename': path.name,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'version': font['name'].getDebugName(5),
        }
        for key, text, phrase_weight in phrases:
            if weight != phrase_weight:
                continue
            letters = []
            for char in text:
                glyph_name = cmap[ord(char)]
                pen = SVGPathPen(glyphs)
                glyphs[glyph_name].draw(TransformPen(pen, (1, 0, 0, -1, 0, units * .8)))
                advance = hmtx[glyph_name][0]
                letters.append({'width': round(advance / units, 6), 'path': pen.getCommands()})
            art[key] = {'text': text, 'weight': weight, 'units': units, 'letters': letters}
        font.close()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(art, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    return art, sources, missing


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fonts', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--mode', choices=['upstream', 'local', 'final'], default='upstream')
    parser.add_argument('--upstream-art', type=Path, help='final 模式：上游 art JSON，用于取 Bold 三句')
    args = parser.parse_args()

    if args.mode == 'final':
        if not args.upstream_art:
            parser.error('final 模式需要 --upstream-art')
        upstream = json.loads(args.upstream_art.read_text(encoding='utf-8'))
        # 本地导出除上游 identity 之外的全部短语（含本站身份标签）
        phrases = [p for p in UPSTREAM_PHRASES if p[0] != 'identity'] + LOCAL_PHRASES
        art, sources, missing = export(args.fonts, args.out, phrases)
        for key in BOLD_FROM_UPSTREAM:
            art[key] = upstream[key]
        # 保持上游的键顺序，便于与上游 diff
        ordered = {key: art[key] for key in upstream if key in art}
        for key, value in art.items():
            ordered.setdefault(key, value)
        args.out.write_text(json.dumps(ordered, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
        print(f'final：{len(ordered)} 短语（本地生成 {len(art) - len(BOLD_FROM_UPSTREAM)}，取自上游 {len(BOLD_FROM_UPSTREAM)}）→ {args.out}（{args.out.stat().st_size} 字节）')
        print(f'  缺少字重：{missing or "无"}（Bold 由上游提供）')
        return 0

    phrases = UPSTREAM_PHRASES if args.mode == 'upstream' else UPSTREAM_PHRASES + LOCAL_PHRASES
    art, sources, missing = export(args.fonts, args.out, phrases)
    print(f'{len(art)} 短语 → {args.out}（{args.out.stat().st_size} 字节）；缺少字重：{missing or "无"}')
    for weight, info in sources.items():
        print(f'  {weight}: {info["filename"]} sha256={info["sha256"][:16]}…')
    return 0


if __name__ == '__main__':
    sys.exit(main())
