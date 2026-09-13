//! fixture：Rust（struct / enum / trait / impl 里的方法 / 自由函数）。

pub const MAX_RETRIES: u32 = 3;

pub struct Store {
    name: String,
}

pub enum Mode {
    Fast,
    Slow,
}

pub trait Reader {
    fn read(&self, key: &str) -> String;
}

impl Store {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
        }
    }

    pub fn read(&self, key: &str) -> String {
        format!("{}{}", self.name, key)
    }
}

pub fn open(name: &str) -> Store {
    Store::new(name)
}
