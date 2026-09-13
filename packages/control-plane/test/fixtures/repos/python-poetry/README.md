# P5 fixture · python-poetry

给环境推断用的最小 Python 仓库（**不是**一个能真的装起来的项目，只够回答"这是什么仓库"）。

| 特征 | 值 | 期望命中 |
|---|---|---|
| 锁文件 | `poetry.lock`（+ `pyproject.toml` 的 `[tool.poetry]`） | 包管理器 poetry |
| 运行时版本 | `requires-python = ">=3.11,<4.0"` | `runtimeVersions.python = 3.11` |
| 自己的 Dockerfile | `FROM python:3.11-slim` | **L2 dockerfile 级** → `base-python-dev` |
| CI | `.github/workflows/ci.yml` | `ciCommands` 里有 `poetry install` |

## 目录

```
pyproject.toml      依赖声明与运行时版本
poetry.lock         锁文件（**空壳**：只用来认包管理器，别真去 install）
Dockerfile          L2 的信号来源：推断只读它的 FROM
src/app/            源码（main.py + __init__.py）
tests/test_app.py   测试文件（语言统计与 verify 命令的依据）
.github/workflows/  CI 的 run 行 → ciCommands
```
