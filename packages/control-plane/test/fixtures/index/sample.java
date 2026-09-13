// fixture：Java（class / interface / enum / 构造器 / 方法；字段刻意不收）。

package sample;

import java.util.List;

public class Store {
    private final String name;

    public Store(String name) {
        this.name = name;
    }

    public String read(String key, List<String> extra) {
        return this.name + key + extra.size();
    }
}

interface Reader {
    String read(String key);
}

enum Mode {
    FAST,
    SLOW,
}
