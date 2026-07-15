use sysinfo::System;

pub struct MetricsSampler {
    sys: System,
}

impl MetricsSampler {
    pub fn new() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();
        Self { sys }
    }

    pub fn cpu_and_memory(&mut self) -> (f32, f32) {
        self.sys.refresh_cpu_usage();
        std::thread::sleep(std::time::Duration::from_millis(200));
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        let cpu = self.sys.global_cpu_usage();
        let total = self.sys.total_memory() as f32;
        let used = self.sys.used_memory() as f32;
        let mem = if total > 0.0 { (used / total) * 100.0 } else { 0.0 };
        (cpu, mem)
    }
}
