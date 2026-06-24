---
title: Firecracker 設定指南
---

# Firecracker 設定指南

這份指南說明如何設定 Firecracker microVM，供 mikan sandbox mode 使用。

警告：mikan 的 Firecracker 支援仍處於非常早期的 alpha。這份指南保留給實驗與驗證使用；它還不是一般開發或 production 建議使用的 sandbox 路徑。除非你正在明確測試 Firecracker，否則請優先使用 `image:<image>`。

## 先決條件

- 支援 KVM 的 Linux host
- 可用 root/sudo 權限設定網路
- VM 使用 SSH key-based authentication

## 安裝步驟

### 1. 安裝 Firecracker binary

```bash
# 下載並安裝 Firecracker
mkdir -p /home/gemini/firecracker
cp release-v1.15.0-x86_64/firecracker-v1.15.0-x86_64 /usr/local/bin/firecracker
chmod +x /usr/local/bin/firecracker

# 驗證
firecracker --version
```

### 2. 下載 kernel 與 rootfs

依照官方 Firecracker getting-started guide 下載 kernel 與 rootfs：

```bash
cd /home/gemini/firecracker

# 從最新 release 取得 CI version
ARCH="x86_64"
release_url="https://github.com/firecracker-microvm/firecracker/releases"
CI_VERSION=$(basename $(curl -fsSLI -o /dev/null -w %{url_effective} ${release_url}/latest))

# 下載 kernel
latest_kernel_key=$(curl "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/${CI_VERSION}/$ARCH/vmlinux-&list-type=2" 2>/dev/null | \
    grep -oP "(?<=<Key>)(firecracker-ci/${CI_VERSION}/$ARCH/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3})(?=</Key>)" | sort -V | tail -1)
wget "https://s3.amazonaws.com/spec.ccfc.min/${latest_kernel_key}" -O vmlinux

# 下載 rootfs squashfs
latest_ubuntu_key=$(curl "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/${CI_VERSION}/$ARCH/ubuntu-&list-type=2" 2>/dev/null | \
    grep -oP "(?<=<Key>)(firecracker-ci/${CI_VERSION}/$ARCH/ubuntu-[0-9]+\.[0-9]+\.squashfs)(?=</Key>)" | sort -V | tail -1)
wget "https://s3.amazonaws.com/spec.ccfc.min/${latest_ubuntu_key}" -O ubuntu-24.04.squashfs.upstream
```

### 3. 解開並設定 rootfs

```bash
cd /home/gemini/firecracker

# 解開 squashfs
unsquashfs ubuntu-24.04.squashfs.upstream

# 產生 VM 存取用 SSH key
ssh-keygen -f id_rsa -N "" -q

# 將 public key 加入 rootfs
mkdir -p squashfs-root/root/.ssh
cp id_rsa.pub squashfs-root/root/.ssh/authorized_keys

# 建立 ext4 filesystem
truncate -s 1G ubuntu-24.04.ext4
mkfs.ext4 -d squashfs-root -F ubuntu-24.04.ext4
```

### 4. 啟動 Firecracker（需要兩個 terminal）

#### Terminal 1：設定網路並啟動 Firecracker

```bash
cd /home/gemini/firecracker

# 設定 tap interface
sudo ip link del tap0 2>/dev/null || true
sudo ip tuntap add dev tap0 mode tap
sudo ip addr add 172.16.0.1/30 dev tap0
sudo ip link set dev tap0 up

# 啟用 IP forwarding
sudo sh -c "echo 1 > /proc/sys/net/ipv4/ip_forward"
sudo iptables -P FORWARD ACCEPT

# 啟動 firecracker
sudo firecracker --api-sock /tmp/firecracker.socket --enable-pci
```

#### Terminal 2：設定 VM

```bash
cd /home/gemini/firecracker
API_SOCKET="/tmp/firecracker.socket"

# 設定 log file
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"log_path": "./firecracker.log", "level": "Debug", "show_level": true, "show_log_origin": true}' \
    "http://localhost/logger"

# 設定 boot source
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"kernel_image_path": "./vmlinux", "boot_args": "console=ttyS0 reboot=k panic=1"}' \
    "http://localhost/boot-source"

# 設定 rootfs
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"drive_id": "rootfs", "path_on_host": "./ubuntu-24.04.ext4", "is_root_device": true, "is_read_only": false}' \
    "http://localhost/drives/rootfs"

# 設定 network interface（MAC 決定 IP：06:00:AC:10:00:02 → 172.16.0.2）
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"iface_id": "net1", "guest_mac": "06:00:AC:10:00:02", "host_dev_name": "tap0"}' \
    "http://localhost/network-interfaces/net1"

# 啟動 VM
sleep 0.5
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"action_type": "InstanceStart"}' \
    "http://localhost/actions"

# 等待開機
sleep 3s

# 設定 guest network 與 DNS
ssh -i ./id_rsa -o StrictHostKeyChecking=no root@172.16.0.2 \
    "ip route add default via 172.16.0.1 && echo 'nameserver 8.8.8.8' > /etc/resolv.conf"
```

### 5. 驗證 SSH 存取

```bash
# 測試 SSH 連線
ssh -i ./id_rsa root@172.16.0.2 "echo 'Connected!' && uname -a"

# 應看到：Connected!
# Linux localhost 6.1.0... x86_64 GNU/Linux
```

## 與 Mikan 搭配使用

VM 啟動後：

```bash
# 使用 Firecracker sandbox 執行 mikan
mikan --sandbox=firecracker:172.16.0.2:/home/gemini/workspace /home/gemini/workspace

# 使用自訂 SSH user
mikan --sandbox=firecracker:172.16.0.2:/home/gemini/workspace:ubuntu /home/gemini/workspace

# 使用自訂 SSH port
mikan --sandbox=firecracker:172.16.0.2:/home/gemini/workspace:root:22 /home/gemini/workspace
```

## 關機

在 VM 內：

```bash
reboot
```

這會正常關閉 Firecracker。若要強制結束：

```bash
sudo killall firecracker
```

## 疑難排解

### KVM access denied

```bash
# 檢查 KVM module
lsmod | grep kvm

# 授權存取
sudo setfacl -m u:${USER}:rw /dev/kvm
# 或將 user 加入 kvm group
sudo usermod -aG kvm ${USER}
```

### VM 無法開機

- 檢查 logs：`tail -f /home/gemini/firecracker/firecracker.log`
- 確認 kernel 與 rootfs path 正確
- 確認 tap interface 已啟用：`ip link show tap0`

### SSH connection refused

- 多等一點讓 VM 開機（試 10 秒）
- 檢查網路：`ping 172.16.0.2`
- 確認 SSH 在 VM 中執行：`ssh -v -i ./id_rsa root@172.16.0.2`

## 檔案摘要

| File                | 說明                            |
| ------------------- | ------------------------------- |
| `vmlinux`           | Firecracker 使用的 Linux kernel |
| `ubuntu-24.04.ext4` | Root filesystem (1GB)           |
| `id_rsa`            | SSH private key（請保密！）     |
| `id_rsa.pub`        | SSH public key                  |
| `firecracker.log`   | Firecracker execution log       |
