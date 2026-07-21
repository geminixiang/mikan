---
title: Firecracker セットアップガイド
description: mikan の experimental Firecracker sandbox モードで使う Firecracker microVM を設定します。
---

警告：mikan の Firecracker サポートは、まだ非常に初期の alpha です。このガイドは実験と検証のために残しています。通常の開発や production で推奨される sandbox 経路ではありません。Firecracker を明示的にテストしている場合を除き、まず `image:<image>` を使ってください。

## 前提条件

- KVM をサポートする Linux host
- ネットワーク設定に使える root/sudo 権限
- VM は SSH key-based authentication を使用

## インストール手順

### 1. Firecracker binary をインストール

```bash
# Firecracker をダウンロードしてインストール
mkdir -p /home/gemini/firecracker
cp release-v1.15.0-x86_64/firecracker-v1.15.0-x86_64 /usr/local/bin/firecracker
chmod +x /usr/local/bin/firecracker

# 検証
firecracker --version
```

### 2. kernel と rootfs をダウンロード

公式 Firecracker getting-started guide に従って kernel と rootfs をダウンロードします。

```bash
cd /home/gemini/firecracker

# 最新 release から CI version を取得
ARCH="x86_64"
release_url="https://github.com/firecracker-microvm/firecracker/releases"
CI_VERSION=$(basename $(curl -fsSLI -o /dev/null -w %{url_effective} ${release_url}/latest))

# kernel をダウンロード
latest_kernel_key=$(curl "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/${CI_VERSION}/$ARCH/vmlinux-&list-type=2" 2>/dev/null | \
    grep -oP "(?<=<Key>)(firecracker-ci/${CI_VERSION}/$ARCH/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3})(?=</Key>)" | sort -V | tail -1)
wget "https://s3.amazonaws.com/spec.ccfc.min/${latest_kernel_key}" -O vmlinux

# rootfs squashfs をダウンロード
latest_ubuntu_key=$(curl "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/${CI_VERSION}/$ARCH/ubuntu-&list-type=2" 2>/dev/null | \
    grep -oP "(?<=<Key>)(firecracker-ci/${CI_VERSION}/$ARCH/ubuntu-[0-9]+\.[0-9]+\.squashfs)(?=</Key>)" | sort -V | tail -1)
wget "https://s3.amazonaws.com/spec.ccfc.min/${latest_ubuntu_key}" -O ubuntu-24.04.squashfs.upstream
```

### 3. rootfs を展開して設定

```bash
cd /home/gemini/firecracker

# squashfs を展開
unsquashfs ubuntu-24.04.squashfs.upstream

# VM アクセス用 SSH key を生成
ssh-keygen -f id_rsa -N "" -q

# public key を rootfs に追加
mkdir -p squashfs-root/root/.ssh
cp id_rsa.pub squashfs-root/root/.ssh/authorized_keys

# ext4 filesystem を作成
truncate -s 1G ubuntu-24.04.ext4
mkfs.ext4 -d squashfs-root -F ubuntu-24.04.ext4
```

### 4. Firecracker を起動（2 つの terminal が必要）

#### Terminal 1：ネットワークを設定して Firecracker を起動

```bash
cd /home/gemini/firecracker

# tap interface を設定
sudo ip link del tap0 2>/dev/null || true
sudo ip tuntap add dev tap0 mode tap
sudo ip addr add 172.16.0.1/30 dev tap0
sudo ip link set dev tap0 up

# IP forwarding を有効化
sudo sh -c "echo 1 > /proc/sys/net/ipv4/ip_forward"
sudo iptables -P FORWARD ACCEPT

# firecracker を起動
sudo firecracker --api-sock /tmp/firecracker.socket --enable-pci
```

#### Terminal 2：VM を設定

```bash
cd /home/gemini/firecracker
API_SOCKET="/tmp/firecracker.socket"

# log file を設定
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"log_path": "./firecracker.log", "level": "Debug", "show_level": true, "show_log_origin": true}' \
    "http://localhost/logger"

# boot source を設定
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"kernel_image_path": "./vmlinux", "boot_args": "console=ttyS0 reboot=k panic=1"}' \
    "http://localhost/boot-source"

# rootfs を設定
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"drive_id": "rootfs", "path_on_host": "./ubuntu-24.04.ext4", "is_root_device": true, "is_read_only": false}' \
    "http://localhost/drives/rootfs"

# network interface を設定（MAC が IP を決める：06:00:AC:10:00:02 → 172.16.0.2）
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"iface_id": "net1", "guest_mac": "06:00:AC:10:00:02", "host_dev_name": "tap0"}' \
    "http://localhost/network-interfaces/net1"

# VM を起動
sleep 0.5
sudo curl -X PUT --unix-socket "${API_SOCKET}" \
    --data '{"action_type": "InstanceStart"}' \
    "http://localhost/actions"

# 起動を待つ
sleep 3s

# guest network と DNS を設定
ssh -i ./id_rsa -o StrictHostKeyChecking=no root@172.16.0.2 \
    "ip route add default via 172.16.0.1 && echo 'nameserver 8.8.8.8' > /etc/resolv.conf"
```

### 5. SSH アクセスを検証

```bash
# SSH 接続をテスト
ssh -i ./id_rsa root@172.16.0.2 "echo 'Connected!' && uname -a"

# 次のように表示されるはず：Connected!
# Linux localhost 6.1.0... x86_64 GNU/Linux
```

## Mikan と組み合わせて使う

VM 起動後：

```bash
# Firecracker sandbox で mikan を実行
mikan --sandbox=firecracker:172.16.0.2:/home/gemini/workspace /home/gemini/workspace

# カスタム SSH user を使う
mikan --sandbox=firecracker:172.16.0.2:/home/gemini/workspace:ubuntu /home/gemini/workspace

# カスタム SSH port を使う
mikan --sandbox=firecracker:172.16.0.2:/home/gemini/workspace:root:22 /home/gemini/workspace
```

## シャットダウン

VM 内で：

```bash
reboot
```

これで Firecracker は正常に終了します。強制終了する場合：

```bash
sudo killall firecracker
```

## トラブルシューティング

### KVM access denied

```bash
# KVM module を確認
lsmod | grep kvm

# アクセスを許可
sudo setfacl -m u:${USER}:rw /dev/kvm
# または user を kvm group に追加
sudo usermod -aG kvm ${USER}
```

### VM が起動しない

- logs を確認：`tail -f /home/gemini/firecracker/firecracker.log`
- kernel と rootfs path が正しいことを確認
- tap interface が有効なことを確認：`ip link show tap0`

### SSH connection refused

- VM 起動まで少し長めに待つ（10 秒試す）
- ネットワークを確認：`ping 172.16.0.2`
- VM 内で SSH が動いていることを確認：`ssh -v -i ./id_rsa root@172.16.0.2`

## ファイル概要

| File                | 説明                                    |
| ------------------- | --------------------------------------- |
| `vmlinux`           | Firecracker が使う Linux kernel         |
| `ubuntu-24.04.ext4` | Root filesystem (1GB)                   |
| `id_rsa`            | SSH private key（秘密にしてください！） |
| `id_rsa.pub`        | SSH public key                          |
| `firecracker.log`   | Firecracker execution log               |
