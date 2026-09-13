// fixture：Go（struct / interface / 别名 / 带接收者的方法）。

package sample

const MaxRetries = 3

type Store struct {
	Name string
}

type Reader interface {
	Read(key string) (string, error)
}

type Key string

func NewStore(name string) *Store {
	return &Store{Name: name}
}

func (s *Store) Read(key string) (string, error) {
	return s.Name + key, nil
}

func (s *Store) Close() error {
	return nil
}
