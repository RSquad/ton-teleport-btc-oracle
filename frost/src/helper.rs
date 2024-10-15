macro_rules! js_throw_on_error {
    ($ctx:expr, $res:expr) => {
        match $res {
            Ok(val) => val,
            Err(err) => return $ctx.throw_error(format!("[FROST:ERROR]: {}", err)),
        }
    };
}