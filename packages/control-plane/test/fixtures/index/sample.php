<?php

// fixture：PHP（interface / class / 构造器 / 方法 / 常量；属性刻意不收）。

const MAX_RETRIES = 3;

interface Reader
{
    public function read(string $key): string;
}

class Store implements Reader
{
    private string $name;

    public function __construct(string $name)
    {
        $this->name = $name;
    }

    public function read(string $key): string
    {
        return $this->name . $key;
    }
}

function open(string $name): Store
{
    return new Store($name);
}
