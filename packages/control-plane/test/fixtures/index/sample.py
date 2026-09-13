"""fixture：Python（装饰器、类方法、模块级常量、局部 lambda）。

【为什么要有一个局部 lambda】`helper = lambda …` 出现在函数体里，它**不该**成为符号：
索引只收"能当跳转目标"的定义，函数体内部的临时变量不是。
"""

from dataclasses import dataclass

MAX_RETRIES = 3


@dataclass
class Session:
    """一个会话。"""

    token: str

    def refresh(self, ttl: int) -> str:
        return f"{self.token}:{ttl}"


def load_session(token: str) -> Session:
    helper = lambda value: value.strip()
    return Session(helper(token))
