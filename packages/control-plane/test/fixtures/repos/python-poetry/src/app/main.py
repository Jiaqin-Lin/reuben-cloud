"""fixture 的"应用"入口（`python -m app`）。"""

from app import greet

if __name__ == "__main__":
    print(greet("world"))
