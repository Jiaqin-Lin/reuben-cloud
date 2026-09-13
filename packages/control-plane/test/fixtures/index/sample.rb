# fixture：Ruby（module 里的 class、实例方法、类方法、模块级常量、顶层方法）。

MAX_RETRIES = 3

module Auth
  class Session
    def initialize(token)
      @token = token
    end

    def refresh(ttl)
      "#{@token}:#{ttl}"
    end

    def self.build(token)
      new(token)
    end
  end
end

def load_session(token)
  Auth::Session.build(token)
end
