#!/usr/bin/env python3
"""
从 SWE-bench Verified 真实数据生成评测任务。
选择 50 个代表性 bug-fix 实例，覆盖不同 repo、难度、bug 类型。
"""

import json
import re
import os

INPUT = os.path.join(os.path.dirname(__file__), '../../data/eval/swebench-verified.parquet')
OUTPUT = os.path.join(os.path.dirname(__file__), '../../data/eval/swebench-verified-curated.json')

import pandas as pd

df = pd.read_parquet(INPUT)

# 过滤：需要 patch 和 test_patch 都不为空
df = df[df['patch'].notna() & (df['patch'] != '') & df['test_patch'].notna() & (df['test_patch'] != '')]
print(f"Total valid instances: {len(df)}")

# 难度映射
def map_difficulty(d):
    if pd.isna(d):
        return 'medium'
    d = str(d).lower()
    if '1-4' in d or 'quick' in d:
        return 'easy'
    if '1-2' in d or 'hour' in d or '2-4' in d:
        return 'hard'
    return 'medium'

df['mapped_difficulty'] = df['difficulty'].apply(map_difficulty)

# 从 patch 中提取修改的文件名
def get_changed_files(patch):
    files = []
    for line in patch.split('\n'):
        m = re.match(r'^\+\+\+ b/(.+)$', line)
        if m:
            fpath = m.group(1)
            # 只关注 Python 源码文件
            if fpath.endswith('.py') and '/test' not in fpath.lower():
                files.append(fpath)
    return files

def get_test_files(test_patch):
    files = []
    for line in test_patch.split('\n'):
        m = re.match(r'^\+\+\+ b/(.+)$', line)
        if m:
            files.append(m.group(1))
    return files

df['changed_files'] = df['patch'].apply(get_changed_files)
df['test_files'] = df['test_patch'].apply(get_test_files)

# 过滤：必须有至少一个修改的 Python 文件和测试文件
df = df[df['changed_files'].apply(len) > 0]
df = df[df['test_files'].apply(len) > 0]
print(f"After filtering for Python files: {len(df)}")

# 从 patch 提取实际的代码变更（简化版：提取修改前的内容作为 buggy code）
def extract_file_content(patch, filename):
    """Extract the full file content from a unified diff."""
    # Find the section for this file
    sections = patch.split('diff --git')
    content_lines = []
    in_file = False

    for section in sections:
        if f'b/{filename}' in section.split('\n')[0] if section.strip() else False:
            in_file = True
            for line in section.split('\n'):
                if line.startswith('@@') or line.startswith('diff --git') or line.startswith('+++') or line.startswith('---') or line.startswith('index ') or line.startswith('new file') or line.startswith('deleted file'):
                    continue
                if line.startswith('+') and not line.startswith('+++'):
                    continue  # Skip added lines (these are the fix)
                if line.startswith('-') and not line.startswith('---'):
                    content_lines.append(line[1:])  # Keep removed lines (buggy code)
                elif line.startswith(' '):
                    content_lines.append(line[1:])  # Context lines
            break

    return '\n'.join(content_lines) if content_lines else None

def extract_test_content(test_patch, filename):
    """Extract the test file content from a unified diff."""
    sections = test_patch.split('diff --git')

    for section in sections:
        if f'b/{filename}' in section.split('\n')[0] if section.strip() else False:
            content_lines = []
            for line in section.split('\n'):
                if line.startswith('@@') or line.startswith('diff --git') or line.startswith('+++') or line.startswith('---') or line.startswith('index ') or line.startswith('new file') or line.startswith('deleted file'):
                    continue
                if line.startswith('+') and not line.startswith('+++'):
                    content_lines.append(line[1:])
                elif line.startswith(' '):
                    content_lines.append(line[1:])
                elif line.startswith('-') and not line.startswith('---'):
                    pass  # Skip removed lines in test
            return '\n'.join(content_lines) if content_lines else None
    return None

# 分类 bug 类型
def categorize_bug(problem_statement, patch):
    ps = str(problem_statement).lower()
    p = str(patch).lower()

    if any(k in ps for k in ['regex', 'regular expression', 'pattern match', 're.']):
        return 'regex'
    if any(k in ps for k in ['off-by-one', 'index', 'boundary', 'edge case', 'last element', 'first element']):
        return 'edge-case'
    if any(k in ps for k in ['thread', 'concurrent', 'race', 'lock', 'async', 'mutex']):
        return 'concurrency'
    if any(k in ps for k in ['error', 'exception', 'raise', 'try', 'except', 'handling', 'validation']):
        return 'error-handling'
    if any(k in ps for k in ['type', 'typeerror', 'none', 'null', 'str', 'int', 'float', 'convert', 'cast']):
        return 'type-error'
    if any(k in ps for k in ['logic', 'incorrect', 'wrong', 'should', 'instead', 'properly']):
        return 'logic-error'
    if any(k in ps for k in ['url', 'http', 'request', 'response', 'api', 'endpoint', 'header']):
        return 'api-misuse'
    if any(k in ps for k in ['import', 'module', 'package', 'dependency']):
        return 'import-error'
    if any(k in ps for k in ['performance', 'slow', 'memory', 'leak', 'inefficient', 'optimize']):
        return 'performance'
    if any(k in ps for k in ['parse', 'format', 'serializ', 'deserializ', 'encode', 'decode', 'json', 'csv', 'xml']):
        return 'parsing'
    return 'logic-error'

# 选择策略：每个 repo 选几个，按难度分层
# 优先选择 patch 较小（<50 行变更）的实例，更适合评测
df['patch_size'] = df['patch'].apply(lambda x: len([l for l in x.split('\n') if l.startswith('+') or l.startswith('-')]))

# 选择 patch_size < 100 的（更容易评测）
df_small = df[df['patch_size'] < 100].copy()
print(f"Instances with small patches (<100 lines): {len(df_small)}")

# 从每个 repo 选取最多 N 个
selected = []
repo_counts = {}
difficulty_counts = {'easy': 0, 'medium': 0, 'hard': 0}

# Sort by patch size (prefer smaller patches)
df_small = df_small.sort_values('patch_size')

for _, row in df_small.iterrows():
    if len(selected) >= 50:
        break

    repo = row['repo']
    diff = row['mapped_difficulty']

    # 每个 repo 最多 5 个
    if repo_counts.get(repo, 0) >= 5:
        continue

    # 难度平衡
    if difficulty_counts[diff] >= 20:
        continue

    # 必须能提取到文件内容
    main_file = row['changed_files'][0]
    test_file = row['test_files'][0]
    buggy_content = extract_file_content(row['patch'], main_file)
    test_content = extract_test_content(row['test_patch'], test_file)

    if not buggy_content or len(buggy_content.strip()) < 20:
        continue
    if not test_content or len(test_content.strip()) < 20:
        continue

    repo_counts[repo] = repo_counts.get(repo, 0) + 1
    difficulty_counts[diff] += 1

    # 生成简化的文件名
    main_basename = os.path.basename(main_file)
    test_basename = os.path.basename(test_file)

    selected.append({
        'instance_id': row['instance_id'],
        'repo': repo,
        'main_file': main_file,
        'test_file': test_file,
        'main_basename': main_basename,
        'test_basename': test_basename,
        'buggy_content': buggy_content,
        'test_content': test_content,
        'problem_statement': row['problem_statement'],
        'difficulty': diff,
        'category': categorize_bug(row['problem_statement'], row['patch']),
        'patch_size': row['patch_size'],
    })

print(f"\nSelected {len(selected)} instances")
print(f"By repo: {dict(repo_counts)}")
print(f"By difficulty: {difficulty_counts}")

# Categories
cat_counts = {}
for s in selected:
    cat_counts[s['category']] = cat_counts.get(s['category'], 0) + 1
print(f"By category: {dict(cat_counts)}")

# 生成评测数据集
existing = []
if os.path.exists(OUTPUT):
    with open(OUTPUT, 'r', encoding='utf-8') as f:
        existing = json.load(f)
    # 给已有任务加 split 标记
    for i, task in enumerate(existing):
        if 'split' not in task.get('metadata', {}):
            task['metadata']['split'] = 'train' if (i + 1) % 7 < 5 else 'test'

print(f"\nExisting tasks: {len(existing)}")

task_num = len(existing) + 1
tasks = list(existing)

for s in selected:
    # 清理 problem_statement，只保留前 500 字符
    desc = str(s['problem_statement'])[:500].strip()
    # 去掉多余空白
    desc = re.sub(r'\n{3,}', '\n\n', desc)

    task_id = f"swebench-{task_num:03d}"
    split = 'train' if task_num % 7 < 5 else 'test'

    tasks.append({
        'id': task_id,
        'source': 'swebench-verified',
        'language': 'python',
        'difficulty': s['difficulty'],
        'description': desc,
        'startingFiles': {
            s['main_basename']: s['buggy_content'],
            s['test_basename']: s['test_content'],
        },
        'testCommand': f'cd $WORKSPACE && python -m pytest {s["test_basename"]} -v',
        'metadata': {
            'category': s['category'],
            'repo': s['repo'],
            'instanceId': s['instance_id'],
            'split': split,
        },
    })

    task_num += 1

# 保存
with open(OUTPUT, 'w', encoding='utf-8') as f:
    json.dump(tasks, f, indent=2, ensure_ascii=False)

train = sum(1 for t in tasks if t.get('metadata', {}).get('split') == 'train')
test = sum(1 for t in tasks if t.get('metadata', {}).get('split') == 'test')
print(f"\nDone! {len(tasks)} total tasks (train: {train}, test: {test})")
