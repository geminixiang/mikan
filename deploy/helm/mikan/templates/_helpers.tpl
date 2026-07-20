{{- define "mikan.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "mikan.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "mikan.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "mikan.labels" -}}
app.kubernetes.io/name: {{ include "mikan.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end }}

{{- define "mikan.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "mikan.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- required "serviceAccount.name is required when serviceAccount.create=false" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "mikan.image" -}}
{{- $image := .image -}}
{{- if $image.digest -}}
{{ printf "%s@%s" $image.repository $image.digest }}
{{- else -}}
{{ printf "%s:%s" $image.repository ($image.tag | default .root.Chart.AppVersion) }}
{{- end -}}
{{- end }}

{{- define "mikan.workspaceStorageClass" -}}
{{- if .Values.storage.workspace.gkeFilestore.createStorageClass -}}
{{- default (printf "%s-filestore-rwx" (include "mikan.fullname" .)) .Values.storage.workspace.gkeFilestore.storageClassName -}}
{{- else -}}
{{- .Values.storage.workspace.storageClassName -}}
{{- end -}}
{{- end }}

{{- define "mikan.workspaceClaim" -}}
{{- default (printf "%s-workspace" (include "mikan.fullname" .)) .Values.storage.workspace.existingClaim }}
{{- end }}

{{- define "mikan.stateClaim" -}}
{{- default (printf "%s-state" (include "mikan.fullname" .)) .Values.storage.state.existingClaim }}
{{- end }}

{{- define "mikan.sandboxTemplateName" -}}
{{- printf "%s-kata" (include "mikan.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "mikan.routerName" -}}sandbox-router{{- end }}
